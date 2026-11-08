import { Plugin } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import { normalizeHistory } from "./history.js";
import { decodeRequest, encodeRequest, isRecord, normalizeOptions, prepareSearchRequest } from "./request.js";

export default Plugin.define({
  id: "opencode-openai-websearch",
  async setup(ctx) {
    const options = normalizeOptions(ctx.options);
    if (!options.enabled) return;

    const registrations: Registration[] = [];
    const dispose = async () => {
      await Promise.all(registrations.splice(0).map((item) => item.dispose()));
    };
    const debug = (message: string) => {
      if (options.debug) console.debug(`[opencode-openai-websearch] ${message}`);
    };
    const scope = { providerID: "openai" };

    try {
      for (const name of ["context", "compaction", "generate", "title"] as const) {
        registrations.push(await ctx.session.hook(name, normalizeHistory, scope));
      }

      registrations.push(await ctx.session.hook("http.request", async (event) => {
        if (event.kind !== "primary" || event.request.method !== "POST") return;
        if (!new URL(event.request.url).pathname.endsWith("/responses")) return;
        if (!event.request.headers.get("content-type")?.includes("application/json")) return;

        const body = await decodeRequest(event.request);
        const prepared = prepareSearchRequest(body, options);
        if (!prepared) {
          debug("HTTP request left unchanged: search unavailable or unsupported body");
          return;
        }
        // OpenAI chooses queries after dispatch; authorize the whole request's search capability.
        await ctx.permission.assert({
          sessionID: event.sessionID,
          agent: event.agent,
          action: "websearch",
          resources: ["*"],
          save: ["*"],
          metadata: { provider: "openai", native: true },
        });
        event.request = encodeRequest(event.request, prepared);
        debug("native search attached to HTTP request");
      }, scope));

      registrations.push(await ctx.session.hook("experimental.ws.send", async (event) => {
        if (event.kind !== "primary") return;
        let body: unknown;
        try {
          body = JSON.parse(event.frame);
        } catch {
          return;
        }
        if (!isRecord(body) || body.type !== "response.create") return;
        const prepared = prepareSearchRequest(body, options);
        if (!prepared) return;
        await ctx.permission.assert({
          sessionID: event.sessionID,
          agent: event.agent,
          action: "websearch",
          resources: ["*"],
          save: ["*"],
          metadata: { provider: "openai", native: true },
        });
        event.frame = JSON.stringify(prepared);
        debug("native search attached to WebSocket request");
      }, scope));
    } catch (error) {
      await dispose();
      throw error;
    }
    return dispose;
  },
});
