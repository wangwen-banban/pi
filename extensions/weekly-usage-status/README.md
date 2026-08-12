# Codex Weekly Usage Status

Adds the remaining OpenAI Codex seven-day quota to pi's footer status line:

```text
weekly 89% remaining · reset 6d 23h
```

The status refreshes at startup, after turns, from Codex response headers, and every five minutes. `/weekly` forces a refresh and shows a notification.

Quota data comes from the official ChatGPT Codex usage endpoint. Authentication is obtained through `pi auth print-bearer-token`, so expired OAuth tokens are refreshed by pi. Only the last percentage and reset timestamp are cached at `~/.pi/agent/cache/codex-weekly-usage.json`; bearer tokens are never persisted by this extension.
