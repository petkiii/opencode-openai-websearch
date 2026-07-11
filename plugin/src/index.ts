import { openai } from "@ai-sdk/openai";

type SearchContextSize = "low" | "medium" | "high";

type Options = {
  enabled?: boolean;
  searchContextSize?: SearchContextSize;
  addSystemHint?: boolean;
  debug?: boolean;
};

type NormalizedOptions = Required<
  Pick<Options, "enabled" | "searchContextSize" | "addSystemHint" | "debug">
>;

type HookInput = {
  model: {
    providerID?: string;
  };
};

type PluginInput = {
  client?: {
    app?: {
      log?: (options: {
        body: {
          service: string;
          level: LogLevel;
          message: string;
          extra?: Record<string, unknown>;
        };
      }) => Promise<unknown>;
    };
  };
};

type RequestOutput = {
  request: Record<string, unknown>;
};

type SystemOutput = {
  system: string[];
};

type ToolResultInput = HookInput & {
  sessionID: string;
  messageID: string;
  partID: string;
  tool: string;
  providerExecuted: boolean;
  rawOutput: unknown;
};

type ToolResultOutput = {
  input?: Record<string, unknown>;
  title: string;
  output: string;
  metadata: Record<string, unknown>;
  attachments?: unknown[];
};

type ServerPlugin = (
  input: PluginInput,
  options?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

type LogLevel = "debug" | "info" | "warn" | "error";

type WebSearchSource =
  | { type: "url"; url: string }
  | { type: "api"; name: string };

const TOOL_NAME = "web_search";
const SERVICE_NAME = "opencode-openai-websearch";
const SYSTEM_HINT = [
  "OpenAI native web search is available for this request.",
  "Use it when the user asks for current, recent, time-sensitive, externally verifiable, or source-backed information.",
  "When citations or sources are available, include them in the answer.",
].join(" ");

function normalizeOptions(
  options?: Record<string, unknown>,
): NormalizedOptions {
  return {
    enabled: options?.enabled !== false,
    searchContextSize: normalizeSearchContextSize(options?.searchContextSize),
    addSystemHint: options?.addSystemHint !== false,
    debug: options?.debug === true,
  };
}

function normalizeSearchContextSize(value: unknown): SearchContextSize {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}
function addWebSearchTool(
  request: Record<string, unknown>,
  options: NormalizedOptions,
) {
  const tools = getTools(request);
  tools[TOOL_NAME] = openai.tools.webSearch({
    searchContextSize: options.searchContextSize,
    externalWebAccess: true,
  });

  addActiveTool(request, TOOL_NAME);
}

function getTools(request: Record<string, unknown>) {
  if (isRecord(request.tools) && !Array.isArray(request.tools))
    return request.tools;

  const tools: Record<string, unknown> = {};
  request.tools = tools;
  return tools;
}

function addActiveTool(request: Record<string, unknown>, toolName: string) {
  if (!Array.isArray(request.activeTools)) return;

  const activeTools = request.activeTools;
  if (!activeTools.includes(toolName)) activeTools.push(toolName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function writeLog(
  input: PluginInput,
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
) {
  try {
    await input.client?.app?.log?.({
      body: {
        service: SERVICE_NAME,
        level,
        message,
        extra,
      },
    });
  } catch {
    // Logging must never affect chat execution.
  }
}

async function writeDebugLog(
  input: PluginInput,
  options: NormalizedOptions,
  message: string,
  extra?: Record<string, unknown>,
) {
  if (!options.debug) return;
  await writeLog(input, "debug", message, extra);
}

function parseWebSearchOutput(output: unknown) {
  if (!isRecord(output)) return;
  const action = output.action;
  const sources = parseSources(output.sources);
  if (!isRecord(action)) return { sources };
  const input = parseActionInput(action);

  return {
    input,
    query: input?.query,
    sources,
  };
}

function parseActionInput(action: Record<string, unknown>) {
  if (action.type === "search" && typeof action.query === "string") {
    return { query: action.query };
  }
  if (action.type === "openPage" && typeof action.url === "string") {
    return { action: action.type, url: action.url };
  }
  if (
    action.type === "findInPage" &&
    typeof action.url === "string" &&
    typeof action.pattern === "string"
  ) {
    return { action: action.type, url: action.url, pattern: action.pattern };
  }
}

function parseSources(value: unknown): WebSearchSource[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((source): WebSearchSource[] => {
    if (!isRecord(source)) return [];
    if (source.type === "url" && typeof source.url === "string") {
      return [{ type: "url", url: source.url }];
    }
    if (source.type === "api" && typeof source.name === "string") {
      return [{ type: "api", name: source.name }];
    }
    return [];
  });
}

function formatSources(sources: WebSearchSource[]) {
  return sources
    .map((source) => {
      if (source.type === "url") return `- ${source.url}`;
      return `- ${source.name}`;
    })
    .join("\n");
}

export const OpenAIWebSearch: ServerPlugin = async (
  pluginInput,
  rawOptions,
) => {
  const options = normalizeOptions(rawOptions);
  await writeLog(pluginInput, "info", "plugin initialized", {
    enabled: options.enabled,
    searchContextSize: options.searchContextSize,
    addSystemHint: options.addSystemHint,
    debug: options.debug,
  });

  if (!options.enabled) return {};

  return {
    "experimental.chat.system.transform": async (
      input: HookInput,
      output: SystemOutput,
    ) => {
      if (input.model.providerID !== "openai") return;

      if (!options.addSystemHint) return;
      if (output.system.includes(SYSTEM_HINT)) return;

      output.system.push(SYSTEM_HINT);
      await writeDebugLog(pluginInput, options, "system hint added", {
        providerID: input.model.providerID,
      });
    },

    "experimental.chat.request.transform": async (
      input: HookInput,
      output: RequestOutput,
    ) => {
      if (input.model.providerID !== "openai") return;

      addWebSearchTool(output.request, options);

      await writeDebugLog(pluginInput, options, "web search tool attached", {
        providerID: input.model.providerID,
        searchContextSize: options.searchContextSize,
      });
    },

    "experimental.chat.tool.result.transform": async (
      input: ToolResultInput,
      output: ToolResultOutput,
    ) => {
      if (input.model.providerID !== "openai") return;
      if (input.tool !== TOOL_NAME) return;

      const parsed = parseWebSearchOutput(input.rawOutput);
      if (!parsed || (!parsed.input && parsed.sources.length === 0)) {
        await writeLog(pluginInput, "warn", "malformed web search output", {
          rawOutputType: typeof input.rawOutput,
        });
        return;
      }

      if (parsed.input) {
        output.input = {
          ...(output.input ?? {}),
          ...parsed.input,
        };
      }
      output.output = formatSources(parsed.sources);
      output.metadata = {
        ...output.metadata,
        sourceCount: parsed.sources.length,
      };

      await writeDebugLog(pluginInput, options, "web search result formatted", {
        query: parsed.query,
        sourceCount: parsed.sources.length,
      });
    },
  };
};

export default {
  id: "opencode-openai-websearch",
  server: OpenAIWebSearch,
};
