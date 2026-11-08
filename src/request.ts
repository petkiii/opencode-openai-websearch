import { gzipSync, gunzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";

type SearchContextSize = "low" | "medium" | "high";
export type Options = {
  enabled: boolean;
  searchContextSize: SearchContextSize;
  addSystemHint: boolean;
  debug: boolean;
};

const SYSTEM_HINT = "OpenAI native web_search is available. Prefer it for current, time-sensitive, or source-backed information. Include source links in your answer when available.";
const SOURCES = "web_search_call.action.sources";

export function normalizeOptions(input: Record<string, unknown>): Options {
  const size = input.searchContextSize;
  return {
    enabled: input.enabled !== false,
    searchContextSize: size === "low" || size === "high" ? size : "medium",
    addSystemHint: input.addSystemHint !== false,
    debug: input.debug === true,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasWebSearch(tools: unknown[]): boolean {
  return tools.some((tool) => isRecord(tool) && (
    (tool.type === "function" && tool.name === "websearch") ||
    (tool.type === "namespace" && Array.isArray(tool.tools) && hasWebSearch(tool.tools))
  ));
}

/** Transform a lowered native body, preserving normal tools and continuation fields. */
export function prepareSearchRequest(body: unknown, options: Options):
  (Record<string, unknown> & { tools: unknown[]; include: string[]; instructions?: string }) | undefined {
  if (!options.enabled || !isRecord(body) || body.tool_choice === "none") return;
  if (!Array.isArray(body.tools) || !hasWebSearch(body.tools)) return;
  if (body.include !== undefined && (!Array.isArray(body.include) || !body.include.every((value) => typeof value === "string"))) return;
  if (body.instructions !== undefined && typeof body.instructions !== "string") return;

  const native = body.tools.some((tool) => isRecord(tool) &&
    (tool.type === "web_search" || tool.type === "web_search_preview"));
  return {
    ...body,
    tools: native ? body.tools : [...body.tools, {
      type: "web_search",
      search_context_size: options.searchContextSize,
      external_web_access: true,
    }],
    include: [...new Set([...(body.include as string[] | undefined ?? []), SOURCES])],
    ...(options.addSystemHint ? {
      instructions: typeof body.instructions === "string" && body.instructions.includes(SYSTEM_HINT)
        ? body.instructions
        : [body.instructions, SYSTEM_HINT].filter(Boolean).join("\n\n"),
    } : {}),
  };
}

export async function decodeRequest(request: Request): Promise<unknown> {
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  if (encoding && !["identity", "gzip", "zstd"].includes(encoding)) return;
  try {
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    const decoded = encoding === "gzip" ? gunzipSync(bytes)
      : encoding === "zstd" ? zstdDecompressSync(bytes) : bytes;
    return JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return;
  }
}

export function encodeRequest(request: Request, body: Record<string, unknown>) {
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  const json = JSON.stringify(body);
  const bytes = encoding === "gzip" ? gzipSync(json)
    : encoding === "zstd" ? zstdCompressSync(json) : new TextEncoder().encode(json);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Request(request, { body: new Uint8Array(bytes), headers });
}
