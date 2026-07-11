import { describe, expect, test } from "bun:test";
import { OpenAIWebSearch } from "../src/index";

type ResultInput = {
  model: { providerID?: string };
  sessionID: string;
  messageID: string;
  partID: string;
  tool: string;
  providerExecuted: boolean;
  rawOutput: unknown;
};

type ResultOutput = {
  input?: Record<string, unknown>;
  title: string;
  output: string;
  metadata: Record<string, unknown>;
  attachments?: unknown[];
};

type ResultHook = (input: ResultInput, output: ResultOutput) => Promise<void>;

async function resultHook() {
  const hooks = await OpenAIWebSearch({}, {});
  return hooks["experimental.chat.tool.result.transform"] as ResultHook;
}

const rawOutput = {
  action: { type: "search", query: "latest release" },
  sources: [
    { type: "url", url: "https://example.com/release" },
    { type: "api", name: "release-api" },
  ],
};

function input(providerID: string, tool = "web_search"): ResultInput {
  return {
    model: { providerID },
    sessionID: "session",
    messageID: "message",
    partID: "part",
    tool,
    providerExecuted: true,
    rawOutput,
  };
}

function output(): ResultOutput {
  return {
    input: { existing: true },
    title: "Existing title",
    output: "Existing output",
    metadata: { existing: true },
  };
}

describe("web search result transform", () => {
  test("ignores non-OpenAI web_search results", async () => {
    const transform = await resultHook();
    const result = output();
    const original = structuredClone(result);

    await transform(input("anthropic"), result);

    expect(result).toEqual(original);
  });

  test("formats OpenAI web_search results", async () => {
    const transform = await resultHook();
    const result = output();

    await transform(input("openai"), result);

    expect(result).toEqual({
      input: { existing: true, query: "latest release" },
      title: "Existing title",
      output: "- https://example.com/release\n- release-api",
      metadata: { existing: true, sourceCount: 2 },
    });
  });

  test("ignores other OpenAI tool results", async () => {
    const transform = await resultHook();
    const result = output();
    const original = structuredClone(result);

    await transform(input("openai", "other_tool"), result);

    expect(result).toEqual(original);
  });
});
