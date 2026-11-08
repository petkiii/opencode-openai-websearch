import { describe, expect, test } from "bun:test";
import { gzipSync, gunzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { Message } from "@opencode/ai/effect";
import plugin from "../src/index.js";
import { normalizeOptions, prepareSearchRequest } from "../src/request.js";
import { host, httpEvent, requestBody, wsEvent } from "./fixture.js";

describe("V2 registration", () => {
  test("scopes hooks to OpenAI, leaves responses untouched, and disposes once", async () => {
    const h = host();
    const cleanup = await plugin.setup(h.context);
    expect([...h.hooks.keys()]).toEqual(["context", "compaction", "generate", "title", "http.request", "experimental.ws.send"]);
    expect([...h.hooks.values()].every((hook) => hook.providerID === "openai")).toBe(true);
    await cleanup?.();
    await cleanup?.();
    expect(h.hooks.size).toBe(0);
    expect(h.disposed).toBe(6);
  });

  test("disabled plugin registers nothing", async () => {
    const h = host({ enabled: false });
    expect(await plugin.setup(h.context)).toBeUndefined();
    expect(h.hooks.size).toBe(0);
  });

  test("rolls back partial setup", async () => {
    const h = host({}, 5);
    await expect(plugin.setup(h.context)).rejects.toThrow("registration failed");
    expect(h.hooks.size).toBe(0);
    expect(h.disposed).toBe(4);
  });
});

describe("native requests", () => {
  test("adds search and source include while preserving local tools and body", async () => {
    const h = host({ searchContextSize: "high" });
    await plugin.setup(h.context);
    const body = requestBody();
    const event = httpEvent(body);
    const original = event.request;
    await h.run("http.request", event);
    const sent = await event.request.json();
    expect(sent.tools.slice(0, 3)).toEqual(body.tools);
    expect(sent.tools[3]).toEqual({ type: "web_search", search_context_size: "high", external_web_access: true });
    expect(sent.include).toEqual(["reasoning.encrypted_content", "web_search_call.action.sources"]);
    expect(sent.input).toEqual(body.input);
    expect(sent.tool_choice).toBe("auto");
    expect(sent.instructions).toStartWith(body.instructions);
    expect(sent.store).toBe(false);
    expect(event.request.headers.get("authorization")).toBe("Bearer fixture-only");
    expect(await original.json()).toEqual(body);
    expect(h.permissions).toEqual([{
      sessionID: event.sessionID, agent: event.agent, action: "websearch",
      resources: ["*"], save: ["*"], metadata: { provider: "openai", native: true },
    }]);
  });

  test.each(["gzip", "zstd", "identity"])("preserves %s encoding, headers and abort", async (encoding) => {
    const h = host();
    await plugin.setup(h.context);
    const event = httpEvent();
    const text = JSON.stringify(requestBody());
    const bytes = encoding === "gzip" ? gzipSync(text) : encoding === "zstd" ? zstdCompressSync(text) : Buffer.from(text);
    const controller = new AbortController();
    event.request = new Request(event.request, {
      body: bytes, signal: controller.signal,
      headers: { "content-type": "application/json", "content-encoding": encoding, "content-length": String(bytes.length), "x-session": "keep" },
    });
    await h.run("http.request", event);
    expect(event.request.headers.get("content-encoding")).toBe(encoding);
    expect(event.request.headers.has("content-length")).toBe(false);
    expect(event.request.headers.get("x-session")).toBe("keep");
    const sent = Buffer.from(await event.request.arrayBuffer());
    const decoded = encoding === "gzip" ? gunzipSync(sent) : encoding === "zstd" ? zstdDecompressSync(sent) : sent;
    expect(JSON.parse(decoded.toString()).tools.at(-1).type).toBe("web_search");
    controller.abort();
    expect(event.request.signal.aborted).toBe(true);
  });

  test("HTTP fallback and WebSocket incremental frame produce same tools", async () => {
    const h = host();
    await plugin.setup(h.context);
    const body = { ...requestBody(), input: [], previous_response_id: "resp_previous" };
    const ws = wsEvent({ ...body, type: "response.create" });
    await h.run("experimental.ws.send", ws);
    const frame = JSON.parse(ws.frame);
    expect(frame.type).toBe("response.create");
    expect(frame.input).toEqual([]);
    expect(frame.previous_response_id).toBe("resp_previous");
    const http = httpEvent(body, "https://chatgpt.com/backend-api/codex/responses");
    await h.run("http.request", http);
    expect((await http.request.json()).tools).toEqual(frame.tools);
  });

  test("permission rejection leaves request/frame unchanged and propagates", async () => {
    const h = host();
    await plugin.setup(h.context);
    h.rejectPermission(new Error("permission rejected"));
    const http = httpEvent();
    const original = http.request;
    await expect(h.run("http.request", http)).rejects.toThrow("permission rejected");
    expect(http.request).toBe(original);
    const ws = wsEvent();
    const frame = ws.frame;
    await expect(h.run("experimental.ws.send", ws)).rejects.toThrow("permission rejected");
    expect(ws.frame).toBe(frame);
  });

  test("rechecks permission on later requests without caching approval", async () => {
    const h = host();
    await plugin.setup(h.context);
    await h.run("http.request", httpEvent());
    h.rejectPermission(new Error("rules changed"));
    await expect(h.run("http.request", httpEvent())).rejects.toThrow("rules changed");
    expect(h.permissions).toHaveLength(2);
  });

  test.each(["compaction", "title", "generate"] as const)("does not inject into %s requests", async (kind) => {
    const h = host();
    await plugin.setup(h.context);
    const http = { ...httpEvent(), kind };
    const original = http.request;
    await h.run("http.request", http);
    expect(http.request).toBe(original);
    const ws = { ...wsEvent(), kind };
    const frame = ws.frame;
    await h.run("experimental.ws.send", ws);
    expect(ws.frame).toBe(frame);
    expect(h.permissions).toHaveLength(0);
  });

  test("ignores other providers and endpoints", async () => {
    const h = host();
    await plugin.setup(h.context);
    const base = httpEvent();
    const event = { ...base, model: { ...base.model, providerID: "anthropic" as typeof base.model.providerID } };
    const original = event.request;
    await h.run("http.request", event);
    expect(event.request).toBe(original);
    const chat = httpEvent(requestBody(), "https://api.openai.com/v1/chat/completions");
    const other = chat.request;
    await h.run("http.request", chat);
    expect(chat.request).toBe(other);
    expect(h.permissions).toHaveLength(0);
  });

  test.each(["br", "zstd"])("leaves unsupported/corrupt %s bodies readable and unchanged", async (encoding) => {
    const h = host();
    await plugin.setup(h.context);
    const event = httpEvent();
    event.request = new Request(event.request, { headers: { "content-type": "application/json", "content-encoding": encoding }, body: "not compressed" });
    const original = event.request;
    await h.run("http.request", event);
    expect(event.request).toBe(original);
    expect(await event.request.text()).toBe("not compressed");
    expect(h.permissions).toHaveLength(0);
  });

  test("ignores invalid JSON and non-create WebSocket frames", async () => {
    const h = host();
    await plugin.setup(h.context);
    for (const frame of ["{", "[]", JSON.stringify({ ...requestBody(), type: "response.cancel" })]) {
      const event = { ...wsEvent(), frame };
      await h.run("experimental.ws.send", event);
      expect(event.frame).toBe(frame);
    }
    expect(h.permissions).toHaveLength(0);
  });
});

describe("request shaping", () => {
  test("preserves existing native declarations, hint and source include on repeated application", () => {
    const options = normalizeOptions({});
    const once = prepareSearchRequest(requestBody(), options)!;
    expect(prepareSearchRequest(once, options)).toEqual(once);
    const existing = { type: "web_search_preview", search_context_size: "low" };
    const result = prepareSearchRequest({ ...requestBody(), tools: [...requestBody().tools, existing] }, options)!;
    expect(result.tools.at(-1)).toBe(existing);
    expect(result.tools).toHaveLength(4);
  });

  test("respects options, forced function selection and namespace tools", () => {
    const options = normalizeOptions({ addSystemHint: false, searchContextSize: "invalid" });
    const forced = { type: "function", name: "read" };
    const result = prepareSearchRequest({ ...requestBody(), tool_choice: forced, tools: [{ type: "namespace", name: "tools", tools: requestBody().tools }] }, options)!;
    expect(result.instructions).toBe("Be accurate.");
    expect(result.tool_choice).toBe(forced);
    expect(result.tools.at(-1)).toMatchObject({ search_context_size: "medium" });
  });

  test.each([
    null, [], {},
    { ...requestBody(), tool_choice: "none" },
    { ...requestBody(), tools: [] },
    { ...requestBody(), tools: [{ type: "function", name: "read" }] },
    { ...requestBody(), tools: {} },
    { ...requestBody(), include: "invalid" },
    { ...requestBody(), instructions: [] },
  ].map((body, index) => ({ body, index })))("leaves unsupported or search-disabled shape unchanged: %j", ({ body }) => {
    const snapshot = structuredClone(body);
    expect(prepareSearchRequest(body, normalizeOptions({}))).toBeUndefined();
    expect(body).toEqual(snapshot);
  });

  test("disabled option does not shape a request", () => {
    expect(prepareSearchRequest(requestBody(), normalizeOptions({ enabled: false }))).toBeUndefined();
  });
});

test("history hooks preserve non-OpenAI messages", async () => {
  const h = host();
  await plugin.setup(h.context);
  const base = httpEvent();
  const event = { ...base, model: { ...base.model, providerID: "anthropic" as typeof base.model.providerID }, system: [], options: {}, messages: [Message.user("keep")] };
  const original = event.messages;
  await h.run("title", event);
  expect(event.messages).toBe(original);
});
