# Pi Agent Configuration

Personal [Pi](https://github.com/earendil-works/pi-coding-agent) agent configuration with custom extensions, provider routing, and workflow enhancements.

## Features

### 🔀 Multi-Provider Routing

Per-provider proxy configuration — different providers use different network paths.

| Provider | Mode | Description |
|----------|------|-------------|
| `claude-relay` | Direct | Claude 中转站（原 code-helper） |
| `claude-relay-alibaba` | Direct | Claude 中转站（Alibaba idealab，支持 opus-5） |
| `openai-codex` | Proxy | OpenAI Codex，走 `127.0.0.1:10808` |

Edit `provider-routing.json` to change proxy port or mode:

```json
{
  "providers": {
    "openai-codex": {
      "mode": "proxy",
      "proxyUrl": "http://127.0.0.1:10808"
    }
  }
}
```

### 📋 Plan Mode

Claude Code–style plan mode with tool-enforced workflow control:

- Model calls `enter_plan_mode` → write tools (bash/edit/write) **blocked**
- Model uses `ask_user` → interactive TUI option cards + free-form "Other" input
- Model calls `exit_plan_mode` → plan rendered for user approval/rejection/feedback
- User approves → write tools unblocked → implementation begins

Manual toggle: `/plan`, `/plan off`, `/plan <reason>`

### 🤖 Smart Sub-agents

Automatic task delegation with model routing:

| Complexity | Model | Thinking |
|-----------|-------|----------|
| simple | gpt-5.4-mini | medium |
| medium | gpt-5.5 | medium |
| complex | gpt-5.6-sol | max |
| critical | gpt-5.6-sol | max |

Sub-agent completions are delivered as **follow-up messages** (not steering interrupts), preserving the parent task's continuity.

### 📊 Custom Status Line

Two-line footer with real-time information:

```
● ⚡DIRECT THINK high T3 ↑12.5k ↓3.2k       claude-relay/claude-opus-4-6[1m] ⎇ main
CODEX WEEK 72% ███████░░░   CTX 84% ████████░░ 840k/1.00M remaining
```

- Provider network mode indicator (⚡DIRECT / ⇄ proxy:…)
- Thinking level display
- Token usage (input/output/cache)
- Codex weekly quota remaining (progress bar)
- Context window remaining (progress bar + absolute values)

### 🌐 Codex Web Search

Web search tool for current/time-sensitive information lookup.

### 📈 Weekly Usage Status

Tracks and displays OpenAI Codex weekly quota consumption.

## Extensions

| Extension | Purpose |
|-----------|---------|
| `provider-routing` | Multi-provider proxy/direct routing + Claude relay registration |
| `plan-mode` | Plan-first workflow with interactive approval |
| `smart-subagents` | Concurrent task delegation with auto-routing |
| `custom-statusline` | Enhanced two-line footer with progress bars |
| `codex-web-search` | Live web search capability |
| `weekly-usage-status` | Codex quota tracking |

## Files

| File | Purpose |
|------|---------|
| `auth.json` | Provider credentials (⚠️ sensitive) |
| `provider-routing.json` | Per-provider network mode and endpoints |
| `subagents.json` | Sub-agent model routing table |
| `models-store.json` | Cached model catalog |
| `settings.json` | Pi settings |
| `AGENTS.md` | Global agent behavior instructions |

## Setup on New Machine

```bash
# Clone
git clone git@github.com:wangwen-banban/pi.git ~/.pi/agent

# Install Pi
npm install -g @earendil-works/pi-coding-agent

# Done — reload or restart Pi
```

## Security

⚠️ This repo contains API keys in `auth.json`. **Keep it private.**

If credentials are rotated, update `auth.json` and push:

```bash
cd ~/.pi/agent && git add -A && git commit -m "rotate keys" && git push
```
