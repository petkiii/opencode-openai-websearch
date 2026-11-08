import type { Plugin } from "@opencode/plugin";
import type { SessionHooks } from "@opencode/plugin/promise/session";

export const identity = {
  sessionID: "ses_search",
  agent: "build",
  model: { providerID: "openai", id: "gpt-6.1-sol" },
  kind: "primary",
} as const;

export function requestBody() {
  return {
    model: identity.model.id,
    input: [{ role: "user", content: "Find the latest release" }],
    instructions: "Be accurate.",
    stream: true,
    store: false,
    tools: [
      { type: "function", name: "websearch", parameters: { type: "object" } },
      { type: "function", name: "read", parameters: { type: "object" } },
      { type: "function", name: "mcp_example", parameters: { type: "object" } },
    ],
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
  };
}

export function httpEvent(body: unknown = requestBody(), url = "https://api.openai.com/v1/responses"): SessionHooks["http.request"] {
  return {
    ...identity,
    request: new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture-only" },
      body: JSON.stringify(body),
    }),
  } as SessionHooks["http.request"];
}

export function wsEvent(body: unknown = { ...requestBody(), type: "response.create" }): SessionHooks["experimental.ws.send"] {
  return { ...identity, frame: JSON.stringify(body) } as SessionHooks["experimental.ws.send"];
}

/** Only the plugin host is substituted. Native protocol/compiler tests use published OpenCode code. */
export function host(options: Record<string, unknown> = {}, failRegistration?: number) {
  type Callback = (event: unknown) => Promise<void> | void;
  const hooks = new Map<keyof SessionHooks, { callback: Callback; providerID?: string }>();
  const permissions: Array<Parameters<Plugin.Context["permission"]["assert"]>[0]> = [];
  let permissionError: Error | undefined;
  let disposed = 0;
  let registrations = 0;
  const hook: Plugin.Context["session"]["hook"] = async (name, callback, scope) => {
    if (++registrations === failRegistration) throw new Error("registration failed");
    hooks.set(name, { callback: callback as Callback, providerID: scope?.providerID });
    return { dispose: async () => { hooks.delete(name); disposed++; } };
  };
  const context = {
    options,
    session: { hook },
    permission: { assert: async (input: Parameters<Plugin.Context["permission"]["assert"]>[0]) => {
      permissions.push(input);
      if (permissionError) throw permissionError;
    } },
  } as unknown as Plugin.Context;
  return {
    context, hooks, permissions,
    get disposed() { return disposed; },
    rejectPermission(error: Error) { permissionError = error; },
    async run<Name extends keyof SessionHooks>(name: Name, event: SessionHooks[Name]) {
      const entry = hooks.get(name);
      if (!entry) throw new Error(`Missing hook: ${name}`);
      if (entry.providerID && "model" in event && event.model.providerID !== entry.providerID) return;
      await entry.callback(event);
    },
  };
}
