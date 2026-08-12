# Codex-first Web Search

A deliberately small pi extension that registers exactly one tool: `web_search`.

The provider/auth patterns were reviewed against [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access) (MIT) and the current OpenAI Codex source. This is a small independent implementation rather than an installation of the full package.

## Routing

1. **OpenAI Codex standalone Web Search** — uses pi's existing `openai-codex` OAuth and the Codex `alpha/search` endpoint.
2. **Exa MCP free search** — zero-key fallback used only if Codex auth/search is unavailable or fails.

Caller cancellation never triggers fallback.

## Scope

Included:

- live text web search
- source URLs
- result count, recency, and domain filters
- automatic Codex → free fallback

Not included:

- page fetching or extraction
- browser/cookie access
- PDF/video/image handling
- curator UI, search cache, source checking, or extra commands
- API-key configuration or new npm dependencies

## Parameters

```ts
web_search({
  query: "latest OpenAI Codex documentation",
  numResults: 5,
  recencyFilter: "month",
  domainFilter: ["openai.com", "-example.com"]
})
```

`recencyFilter` supports `day`, `week`, `month`, and `year`.

## Activation

Run `/reload` in the current pi session, or restart pi.
