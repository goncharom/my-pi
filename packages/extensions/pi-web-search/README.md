# pi-web-search

Adds a `web_search` tool backed by OpenAI's hosted live web search.

The extension reuses Pi's existing `openai-codex` ChatGPT OAuth login. It does not read `auth.json` directly and does not require an `OPENAI_API_KEY`.

## Setup

In Pi, run:

```text
/login openai-codex
```

The tool is then available to the model automatically.

By default, searches use the active model when it is an OpenAI Codex model. With another active provider, the search request falls back to `gpt-5.6-luna`. Set `PI_WEB_SEARCH_MODEL` to select another OpenAI Codex model.

The tool returns the search response and source URLs to the calling model. The model decides how to summarize and cite them.

Like Pi's bash tool, output is limited to the last 2,000 lines or 50KB, whichever is reached first. When output is truncated, the complete response is written to a `pi-web-search-*.log` file in the system temporary directory and its path is included in the tool result.
