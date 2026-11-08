import { Message } from "@opencode/ai/effect";
import type { ContentPart } from "@opencode/ai/effect";
import type { SessionRequest } from "@opencode/plugin/promise/session";
import { isRecord } from "./request.js";

/** Restore only proven native search items; never change persisted history. */
export function normalizeHistory(event: SessionRequest) {
  event.messages = event.messages.map((message) => {
    const content = message.content.map(normalizePart);
    return content.some((part, index) => part !== message.content[index])
      ? new Message({ ...message, content }) : message;
  });
}

function normalizePart(part: ContentPart): ContentPart {
  if (part.type !== "tool-result" || part.providerExecuted !== true || part.name !== "web_search") return part;
  if (part.result.type !== "text" || typeof part.result.value !== "string") return part;
  const metadata = part.providerMetadata?.openai;
  if (!isRecord(metadata) || metadata.itemId !== part.id) return part;
  try {
    const item: unknown = JSON.parse(part.result.value);
    if (!isRecord(item) || item.type !== "web_search_call" || item.id !== part.id) return part;
    if (item.error != null || item.status !== "completed") return part;
    if (item.action != null && !isRecord(item.action)) return part;
    return { ...part, result: { type: "json", value: item } };
  } catch {
    return part;
  }
}
