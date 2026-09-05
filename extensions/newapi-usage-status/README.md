# Shared NewAPI Usage Status

Shows the quota recorded by the lab NewAPI gateway for `cambricon-codex` and
`claude-cambricon`. Both aliases must resolve to the same safe host and use the
same API key; otherwise the extension fails closed instead of displaying a
misleading shared balance.

The TUI status is refreshed on session start, model changes, completed turns,
and every five minutes. `/newapi` forces a refresh. The custom footer renders
both aliases with the same `NEW API` capacity bar and cache:

```text
NEW API 49% ━━━━━───── EXPIRES 94d 2h
```

Unlimited accounts render `NEW API ∞`. Network requests use Node's direct
HTTP(S) transport rather than `HTTP_PROXY`/`HTTPS_PROXY`, because the lab usage
endpoint requires proxy bypass. The API key is read from Pi's model registry
and is never logged or persisted by this extension.

Only numeric quota state is cached at
`~/.pi/agent/cache/newapi-usage.json` (directory `0700`, file `0600`, atomic
same-directory replacement). The cache contains no key, host, account name,
model limits, prompts, outputs, or provider-specific task data.
