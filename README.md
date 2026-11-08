# opencode-openai-websearch

OpenAI-native web search for OpenCode V2. The plugin adds OpenAI's hosted `web_search` to the normal model request while keeping OpenCode's local tools, MCP tools, and agent loop available.

## Install

Requirements: OpenCode V2 (compatibility baseline **2.2.2**), Bun **1.4.4+**, and Git. V1 is not supported.

```sh
git clone https://github.com/petkii/opencode-openai-websearch.git
cd opencode-openai-websearch
bun install --frozen-lockfile --ignore-scripts --omit=peer
```

Add the plugin to your OpenCode configuration using an absolute path for global configuration:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-openai-websearch",
      "options": {
        "searchContextSize": "medium"
      }
    }
  ]
}
```

Restart OpenCode after configuration changes.

## ChatGPT subscription login

In OpenCode, run `/connect`, select **OpenAI**, and choose **Sign in with ChatGPT**, **Codex browser (legacy)**, or **Codex device code (legacy)**. Then select an available model with `/models`.

The new login uses HTTP Responses requests with ChatGPT plan authorization. Legacy Codex login normally uses WebSocket requests with HTTP fallback. The plugin supports both transports. API-key Responses requests under provider `openai` follow the same hook path, but separate API billing applies.

The native tool is named `web_search`. OpenCode's ordinary `websearch` tool remains available. An optional hint asks the model to prefer native search. The model chooses whether to search on each request.

Citations are not formatted.

## Permissions

The plugin uses OpenCode's existing **`websearch`** permission action.

## Options

Defaults:

```json
{
  "enabled": true,
  "searchContextSize": "medium",
  "addSystemHint": true,
  "debug": false
}
```

`searchContextSize` accepts `low`, `medium`, or `high` and defaults to `medium`. Existing provider-native search declarations keep their settings. Debug logging records hook decisions only, without credentials, prompts, or search content.

## Web search history

The plugin restores previous searches to OpenAI's native format for follow-ups and resumed sessions. Stored transcripts are unchanged.
