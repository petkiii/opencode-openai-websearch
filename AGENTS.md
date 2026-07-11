# AGENTS.md

## Project

Goal: make OpenAI-native web search work in opencode without replacing opencode's normal agent/tool flow. The current approach patches the local opencode checkout to add missing tool-call/request hooks, then uses those hooks from the `opencode-openai-websearch` plugin. The plugin injects OpenAI's provider-native web search tool into chat requests and formats provider-executed web search results so opencode can store and display them correctly.

## Web search

Use web search whenever facts may be outdated, uncertain, version-specific, or important.
Prefer verifying over guessing. Use current sources for docs, APIs, errors, releases, prices, dates, security issues, and recommendations.
Skip research only for simple local code edits or user-provided content.
