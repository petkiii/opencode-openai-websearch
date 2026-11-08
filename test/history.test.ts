import { describe, expect, test } from "bun:test";
import { LLM, Message } from "@opencode/ai/effect";
import type { ContentPart, LLMEvent, ToolResultPart } from "@opencode/ai/effect";
import { OpenAIResponses } from "@opencode/ai/protocols/openai-responses";
import { compileRequest } from "@opencode/ai/testing";
import type { SessionRequest } from "@opencode/plugin/promise/session";
import { Effect, Schema } from "effect";
import { normalizeHistory } from "../src/history.js";
import plugin from "../src/index.js";
import { host, httpEvent } from "./fixture.js";

const item = {
  type: "web_search_call", id: "ws_123", status: "completed",
  action: { type: "search", queries: ["latest Bun release"], sources: [{ type: "url", url: "https://bun.sh/blog" }] },
};

function storedPart(): ToolResultPart {
  return {
    type: "tool-result", id: item.id, name: "web_search", providerExecuted: true,
    result: { type: "text", value: JSON.stringify(item) },
    providerMetadata: { openai: { itemId: item.id } },
    metadata: { keep: true },
  };
}

function context(part: ContentPart = storedPart()): SessionRequest {
  return {
    sessionID: httpEvent().sessionID, model: httpEvent().model,
    system: [], options: {},
    messages: [
      Message.user("Search for current releases"),
      new Message({ id: "message_1", role: "assistant", metadata: { keep: "message" }, content: [
        { type: "reasoning", text: "Check a primary source." },
        { type: "tool-call", name: "web_search", id: item.id, input: item.action, providerExecuted: true },
        part,
        { type: "text", text: "Here is the release information." },
      ] }),
      Message.user("Compare it with the previous version"),
    ],
  };
}

describe("structured hosted history", () => {
  test("restores exact item, preserving all other content and persisted representation", () => {
    const event = context();
    const persisted = event.messages;
    const snapshot = JSON.stringify(persisted);
    normalizeHistory(event);
    expect(event.messages[0]).toBe(persisted[0]);
    expect(event.messages[2]).toBe(persisted[2]);
    expect(event.messages[1]).toBeInstanceOf(Message);
    expect(event.messages[1]?.id).toBe("message_1");
    expect(event.messages[1]?.metadata).toEqual({ keep: "message" });
    const before = persisted[1]!.content;
    const after = event.messages[1]!.content;
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(after[3]).toEqual(before[3]);
    expect(after[2]).toEqual({ ...storedPart(), result: { type: "json", value: item } });
    expect(JSON.stringify(persisted)).toBe(snapshot);
    const normalized = event.messages[1];
    normalizeHistory(event);
    expect(event.messages[1]).toBe(normalized);
  });

  test.each(["context", "compaction", "generate", "title"] as const)("normalizes %s history without adding search or changing request options", async (name) => {
    const h = host();
    await plugin.setup(h.context);
    const event = { ...context(), agent: httpEvent().agent, tools: {} };
    const originalOptions = event.options;
    const originalSystem = event.system;
    await h.run(name, event);
    expect(event.messages[1]!.content[2]).toMatchObject({ result: { type: "json", value: item } });
    expect(event.options).toBe(originalOptions);
    expect(event.system).toBe(originalSystem);
    expect(h.permissions).toHaveLength(0);
  });

  const invalidParts: ToolResultPart[] = [
    { ...storedPart(), providerExecuted: false },
    { ...storedPart(), name: "read" },
    { ...storedPart(), id: "other" },
    { ...storedPart(), providerMetadata: undefined },
    { ...storedPart(), providerMetadata: { openai: { itemId: "other" } } },
    { ...storedPart(), result: { type: "text", value: "- https://old-v1.example" } },
    { ...storedPart(), result: { type: "text", value: "null" } },
    { ...storedPart(), result: { type: "text", value: "[]" } },
    { ...storedPart(), result: { type: "text", value: JSON.stringify({ ...item, type: "function_call" }) } },
    { ...storedPart(), result: { type: "text", value: JSON.stringify({ ...item, id: "other" }) } },
    { ...storedPart(), result: { type: "text", value: JSON.stringify({ ...item, status: "failed" }) } },
    { ...storedPart(), result: { type: "text", value: JSON.stringify({ ...item, error: { message: "failed" } }) } },
    { ...storedPart(), result: { type: "text", value: JSON.stringify({ ...item, action: "invalid" }) } },
    { ...storedPart(), result: { type: "error", value: "failed" } },
    { ...storedPart(), result: { type: "json", value: item } },
  ];
  test.each(invalidParts)("leaves unproven/failed/legacy result untouched: %j", (part) => {
    const event = context(part);
    const original = event.messages[1];
    normalizeHistory(event);
    expect(event.messages[1]).toBe(original);
  });

  test("does not parse search-looking user text", () => {
    const event = { ...context(), messages: [Message.user(JSON.stringify(item))] };
    const original = event.messages[0];
    normalizeHistory(event);
    expect(event.messages[0]).toBe(original);
  });

  test.each(["gpt-6.1-sol", "gpt-6-astra"])("native compiler replays exact search item on %s after history reload", async (id) => {
    const event = context();
    normalizeHistory(event);
    const request = LLM.request({
      model: OpenAIResponses.route.model({ id }),
      messages: event.messages,
    });
    const compiled = await Effect.runPromise(compileRequest(request));
    const body = compiled.body as { input: Array<Record<string, unknown>> };
    expect(body.input).toContainEqual(item);
    expect(body.input.some((part) => part.type === "function_call_output" && part.call_id === item.id)).toBe(false);
    expect(body.input.at(-1)).toMatchObject({ type: "message", role: "user" });
  });
});

test("real Responses parser preserves native search, ordinary tools, and unformatted answer text", async () => {
  const request = LLM.request({ model: OpenAIResponses.route.model({ id: "gpt-6.1-sol" }), messages: [Message.user("Search")] });
  const parser = OpenAIResponses.protocol.stream;
  let state = parser.initial(request);
  const events: LLMEvent[] = [];
  const answer = "Release details. citeturn0search0";
  const frames = [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_read", call_id: "call_read", name: "read", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_read", output_index: 1, delta: '{"path":"README.md"}' },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_read", call_id: "call_read", name: "read", arguments: '{"path":"README.md"}' } },
    { type: "response.output_item.added", output_index: 2, item: { type: "message", id: "msg_answer", role: "assistant", content: [] } },
    { type: "response.output_text.delta", item_id: "msg_answer", output_index: 2, content_index: 0, delta: answer },
    { type: "response.output_item.done", output_index: 2, item: { type: "message", id: "msg_answer", role: "assistant", content: [{ type: "output_text", text: answer, annotations: [{ type: "url_citation", url: "https://bun.sh/blog", title: "Bun", start_index: 17, end_index: answer.length }] }] } },
    { type: "response.completed", response: { id: "resp_test", usage: { input_tokens: 10, output_tokens: 4 } } },
  ];
  for (const frame of frames) {
    const event = Schema.decodeUnknownSync(parser.event)(JSON.stringify(frame));
    const [next, emitted] = await Effect.runPromise(parser.step(state, event));
    state = next;
    events.push(...emitted);
  }
  expect(events).toContainEqual(expect.objectContaining({ type: "tool-call", name: "web_search", providerExecuted: true, input: item.action }));
  expect(events).toContainEqual(expect.objectContaining({ type: "tool-result", name: "web_search", providerExecuted: true, result: { type: "json", value: item } }));
  const local = events.find((event) => event.type === "tool-call" && event.name === "read");
  expect(local).toMatchObject({ input: { path: "README.md" } });
  expect(local && "providerExecuted" in local && local.providerExecuted).not.toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ type: "text-end", text: answer }));
});
