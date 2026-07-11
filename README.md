# opencode-openai-websearch

OpenAI-native web search for OpenCode.

This project adds OpenAI's provider-native web search tool to OpenCode requests without replacing OpenCode's normal agent and tool flow. The approach: patch a local OpenCode checkout to expose the missing request/result hooks, then load a normal OpenCode plugin that injects `web_search` for OpenAI models and formats provider-executed search results for OpenCode history.

## INSTALL

Requirements:

- Bun.
- Git.

Clone and build:

```sh
git clone https://github.com/petkii/opencode-openai-websearch.git
cd opencode-openai-websearch
bun run build
```

`bun run build` installs workspace dependencies, creates or updates `./opencode`, applies patches on branch `local/patch`, and builds a patched OpenCode binary.

Run the built binary, use the binary path printed by the build.
For example:

```sh
./opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode
```

Optionally make it available as `opencodeweb`.

Create a symlink in a directory already on your `PATH`.
For example:

```sh
ln -sf "$PWD/opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode" "$HOME/.local/bin/opencodeweb"
```

Or define a shell alias:

```sh
alias opencodeweb="$PWD/opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode"
```

Add the plugin to OpenCode config. Use an absolute path in global config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "/absolute/path/to/opencode-openai-websearch/plugin",
      {
        "searchContextSize": "medium"
      }
    ]
  ]
}
```

Restart OpenCode after changing config.

## USAGE: patching workflow

Normal update flow:

```sh
bun run build
```

What it does:

- Clones `anomalyco/opencode` into `./opencode` if missing.
- Fetches upstream tags and picks the latest non-patched version tag.
- Checks out or creates `local/patch` in `./opencode`.
- Applies `patcher/patches/*.patch`.
- Stamps OpenCode package versions with `-patched`.
- Builds a standalone OpenCode binary and verifies its version.

Patcher stages can also be run directly:

```sh
bun patcher/patcher.ts
bun patcher/patcher.ts --build
```

- No flags: clone/update OpenCode, install dependencies, apply patches, and stamp versions.
- `--build`: default steps plus build and binary verification.

## FEATURES

- Adds OpenAI provider-native `web_search` to OpenAI model requests.
- Keeps OpenCode's normal tools and agent flow in place.
- Formats provider-executed search results into OpenCode-visible tool output.
- Supports `searchContextSize`: `low`, `medium`, or `high`.
- Supports optional system hint insertion with `addSystemHint`.
- Does nothing for non-OpenAI providers.

Plugin options:

```json
{
  "enabled": true,
  "searchContextSize": "medium",
  "addSystemHint": true,
  "debug": false
}
```

## HOW DOES IT WORK

The plugin lives at `plugin/src/index.ts`.

For each OpenAI request, it uses the patched `experimental.chat.request.transform` hook to add `openai.tools.webSearch()` as `web_search`. The request still goes through OpenCode's existing `streamText` path, so normal OpenCode tools remain part of the same turn.

When OpenAI executes web search provider-side, the patched `experimental.chat.tool.result.transform` hook gives the plugin the raw provider output. The plugin extracts the search action and sources, then rewrites the OpenCode tool result so history and UI can display useful source output.

The patches live in `patcher/patches/`:

- `chat-request-transform.patch` adds the request transform hook before OpenCode calls `streamText`.
- `chat-tool-result-transform.patch` adds the tool-result transform hook before OpenCode stores completed tool output.
- `skip-powershell-native-install.patch` removes `tree-sitter-powershell` from OpenCode'r trusted dependency list. OpenCode loads its bundled WASM parser, so compiling its Node binding is unnecessary and can fail when Bun cannot resolve `node-gyp` during a clean install.

## Why not just the OpenCode plugin SDK?

The public/current plugin hook surface alone is not enough for this feature.

The plugin needs two things OpenCode did not expose here:

- Mutate the provider request immediately before `streamText`, so OpenAI's native web search tool can be attached.
- Receive provider-executed web search output before OpenCode stores the completed tool result, so sources can be normalized for history/UI.

The local patches add those missing hook points. If OpenCode later ships equivalent hooks upstream, this repo can drop some or all of the patching layer.

## Uninstall

- Remove the plugin entry from OpenCode config.
- Remove the symlink if used.
- Delete `opencode-openai-websearch` repo.

## NOTE

Heavily videcoded, no guarantees.
