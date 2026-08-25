# Pi Agent Configuration

Personal [pi](https://github.com/badlogic/pi-mono) configuration with multi-provider routing, plan mode, sub-agents, multi-account Codex OAuth, BTW side conversations, web search, and a custom status line.

## Provider Routing

| Provider | Mode | Description |
|----------|------|-------------|
| `claude-relay` | Direct | Claude relay |
| `claude-relay-alibaba` | Direct | Alibaba ideaLAB relay, including Opus 5 |
| `big-data-claude` | Direct | Big Data Claude relay |
| `openai-codex` | Configurable | Primary Codex OAuth account |
| `openai-codex-second` | Follows primary | Secondary Codex OAuth account; shares the primary route |

Edit `provider-routing.json` to change the primary Codex route:

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

`openai-codex-second` automatically follows this direct/proxy setting. Its OAuth credentials and quota cache remain independent from the primary account.

## Main Extensions

| Extension | Purpose |
|-----------|---------|
| `provider-routing` | Multi-provider direct/proxy transport, relay registration, retries, SSE error reporting |
| `codex-multi-account` | Independent OAuth identity for `openai-codex-second` |
| `plan-mode` | Tool-enforced read-only planning with interactive approval |
| `smart-subagents` | Concurrent task delegation with model routing |
| `background-tasks` | Dynamic main-agent task plan plus managed long-command completion wakeups |
| `btw` | Ephemeral multi-turn side conversations with compaction-aware parent context, Enter-to-steer, Tab follow-ups, and optional `/keep` persistence |
| `custom-statusline` | Provider, thinking, token, context, and Codex quota status |
| `codex-web-search` | Live web search |
| `weekly-usage-status` | Per-account Codex weekly quota tracking |

The provider transport uses pi's official virtual modules. It does not depend on a fixed nvm/npm installation path. If `undici` is unavailable, it falls back to a Node-core HTTP(S) transport supporting direct requests, HTTP(S) proxies, CONNECT tunnels, streaming, aborts, and relay TLS compatibility.

## Setup on a New Machine

```bash
# Install pi
npm install -g @earendil-works/pi-coding-agent

# Clone this configuration
git clone git@github.com:wangwen-banban/pi.git ~/.pi/agent

# Ensure helper scripts are executable
chmod +x ~/.pi/agent/scripts/*.sh

# Restore the provider-first, model-second selector package patch
~/.pi/agent/scripts/apply-model-selector-patch.sh

# Restore or verify history navigation and /rewind patches (Pi 0.84.1)
~/.pi/agent/scripts/apply-history-navigation-patch.sh
~/.pi/agent/scripts/apply-history-navigation-patch.sh --check

# Install and start the loopback-only PI WEB user services
~/.pi/agent/scripts/setup-pi-web.sh

# Start pi
pi
```

`auth.json` is intentionally excluded from Git and will not be present after cloning.

- For Codex accounts, use `/login` to authorize on the new machine.
- For custom API providers, recreate the API keys locally or transfer `auth.json` through a secure channel.
- Keep local credential permissions restricted:

```bash
chmod 600 ~/.pi/agent/auth.json
```

## Second Codex Account

1. Run `/reload` after updating the configuration.
2. Run `/login`.
3. Select `openai-codex-second`.
4. Prefer **Device Code** authentication.
5. Open the authorization URL in an incognito window or a separate browser profile logged into account B.
6. Run `/model` and select a model under `openai-codex-second`.

After both accounts are authorized, switch accounts through `/model`; repeated logout/login is not required. The footer and `/weekly` use the quota belonging to the currently selected provider.

## Codex Fast Mode

For either Codex OAuth account, toggle the current Pi session's Fast service tier with:

```text
/fast
/fast on
/fast off
/fast status
```

Fast mode maps to the Codex request option `serviceTier: "priority"` and displays `⚡FAST` in the custom statusline. It is branch-aware and survives `/reload`/resume, but remains scoped to the current main session; sub-agent workers stay on Standard. The current catalog supports GPT-5.6 Sol/Terra/Luna, GPT-5.5, and GPT-5.4 (not GPT-5.4-mini). Fast provides roughly 1.5× speed at higher usage: GPT-5.6/5.5 consume about 2.5× Standard ChatGPT credits and GPT-5.4 about 2×. See [OpenAI Codex Speed](https://developers.openai.com/codex/speed).

## Two-Level Model Selector

The `/model` UI is a package-level patch: select a provider first, then expand it to select a concrete model. It is versioned under:

```text
patches/pi-model-selector/0.84.1/model-selector.patch
```

Install or verify it with:

```bash
~/.pi/agent/scripts/apply-model-selector-patch.sh
~/.pi/agent/scripts/apply-model-selector-patch.sh --check
```

The installer locates the global pi package without assuming a fixed nvm path. It only patches the exact supported official version/hash, applies changes in a temporary file, validates JavaScript syntax and the final hash, and safely refuses unknown or modified installations.

An npm update may replace the patched vendor file. Run `--check` after updating pi. If the installed version is newer than `0.84.1`, do not force-copy the old JavaScript file; generate and validate a patch for the new version instead.

## History Navigation and `/rewind`

- **History navigation:** before browsing, ↑/↓ retain normal multiline-cursor behavior. In browse mode, ↑ moves to older history and ↓ to newer history; passing the newest entry restores the draft. Editing a recalled item exits browse mode. The global patch takes effect after restarting Pi.
- **`/rewind`:** each invocation opens the selector. Choosing a user turn truncates that turn and everything after it from active context/transcript logic, and returns the selected text to the composer. Original JSONL and old branches remain available through `/tree`; files are not rolled back. It refuses while Pi is busy and works in TUI and PI WEB.
- Images and other attachments are not restored automatically: only text is recovered, so re-attach them manually before resubmitting.

The `smart-subagents` lifecycle reports duration in real time, uses a 30-minute default hard timeout with a 5-second TERM grace period, and records durable `stopped` results across reload/shutdown. See its dedicated README for details.

## Local TUI ↔ Phone/Web Session Handoff

The local `pi` TUI and PI WEB (phone) write to the **same session JSONL file**, but each process keeps its own in-memory session state. They do not live-sync: messages sent from the phone appear in the file, but a still-open local TUI does not automatically pick them up.

### Leaving home (local → phone)

Nothing special needed. The phone's PI WEB page reads the session file directly and always shows the latest state, including everything you did locally.

### Coming home (phone → local)

The still-open local TUI is now stale: the phone appended messages the TUI has not seen. **Do not type in the stale TUI** — input would branch from an old position and fork the session tree.

Instead, run the built-in `/sync` command (from the `session-sync` extension):

1. Wait for the agent to finish (if running).
2. Type `/sync`.
3. The session reloads from disk, landing on the latest leaf — including all phone messages.

The extension also watches the session file in the background. When it detects external writes (phone appending while the local TUI is idle), it shows a persistent warning:

```
┌─────────────────────────────────────────────────────┐
│  ⚠  Session was modified externally (phone/web).    │
│                                                     │
│  Run /sync to reload the latest state.              │
│  Typing here now will branch from a stale position. │
└─────────────────────────────────────────────────────┘
```

The warning clears automatically after `/sync` or any local activity.

### If you already typed in a stale TUI (recovery)

If you accidentally sent input from a stale position, the session file now contains a branch fork. Both branches are preserved — nothing is lost. To recover:

1. Run `/sync` to reload the latest state.
2. Run `/tree` to open the session tree.
3. Navigate to the branch that contains the phone conversation.
4. Select the last entry on that branch to continue from there.

### Extension details

- Extension: `extensions/session-sync/index.ts`
- Test: `extensions/session-sync/test-drift.mjs`
- Only active in TUI mode; RPC/print/JSON modes are unaffected.
- `/sync` refuses to run while the agent is streaming (to avoid aborting active work).

## Main-agent Background Tasks

For a long benchmark, build, deployment, training run, or data job, the main agent can maintain a dynamic Codex-style plan with `update_task_plan`, then start the blocking step with `run_background_task`. The managed tool returns immediately and owns the command lifecycle; raw `cmd &`, `nohup`, `disown`, and PID polling are intentionally not used.

The task list remains editable while the command runs. New user prompts can add, remove, or reprioritize work using the current plan revision. It is a current-goal view rather than permanent history: the model omits terminal or obsolete tasks once their outcomes no longer affect analysis, retry, verification, or decisions; active managed runs remain protected. Exit 0, non-zero exit, signal, timeout, or explicit stop updates the linked task and injects one safe follow-up that wakes the main LLM. Completion never interrupts an in-flight answer. The append-only transcript, completion message, and private result logs retain historical outcomes.

```text
/tasks
/tasks stop <run-id-or-task-id>
/tasks stop all
/tasks clear-completed
```

Private logs live under `~/.pi/agent/background-task-runs/` with user-only permissions and are Git-ignored. PI WEB Activity receives only task ids/names, statuses, revision, and timing—never the command, full task text, output, credentials, context, or PID. See [`extensions/background-tasks/README.md`](extensions/background-tasks/README.md).

## Remote Control with PI WEB

[`@jmfederico/pi-web@1.202608.1`](https://github.com/jmfederico/pi-web) runs as an independent browser service compatible with Pi `0.84.1`. It is installed globally, not loaded as a Pi Extension, so it does not add `/pi-web` or extra extension code to normal Pi processes.

The configured scope is intentionally small:

- keep sessions alive and show replies, tool calls, status and errors in real time;
- send steering/follow-up messages, stop work and answer `ask_user` prompts;
- switch models and thinking levels;
- browse only explicitly registered project folders, inspect Git status/diffs and use an emergency project terminal;
- disable agent-created sessions, tracked subsessions, environment facts, Workspace Tasks, Relays and update plugins;
- allow no external filesystem roots;
- bind only to `127.0.0.1:8504`.

The Files and Terminal views can modify project data. Only add trusted project folders; do not register the whole home directory or `/`.

### Install or repair

```bash
~/.pi/agent/scripts/setup-pi-web.sh
```

Verify without changing anything:

```bash
~/.pi/agent/scripts/setup-pi-web.sh --check
```

Open locally at <http://127.0.0.1:8504>. Use **Actions → Add Project**, enter one project directory, select its workspace, then start or resume a session.

### Activity panel for phone/background work

Install the trusted browser-only Activity plugin (no web/sessiond restart):

```bash
~/.pi/agent/scripts/setup-pi-web-activity-plugin.sh
~/.pi/agent/scripts/setup-pi-web-activity-plugin.sh --check
```

Then hard-refresh the browser. The **Activity** workspace panel and badge show sub-agent routing/queue/running/stopping/terminal states, dynamic main-agent task plans and managed background runs, model/thinking, locally ticking elapsed time, progress age, stale/disconnected state, Plan Mode, and safe sub-agent Stop one/all controls. Records survive browser reconnects under the Git-excluded workspace path `.pi/.runtime/pi-web-activity/v1/`; they never contain full delegated tasks, parent context, live output, credentials, or PIDs.

After changing the supporting Pi extensions, wait until no delegated worker is active and run `/reload` once in chat. Reloading while a worker is active intentionally stops it. A browser hard refresh loads browser-plugin changes; `/reload` loads Pi extension changes. Neither action requires restarting sessiond.

Workers retain `--no-extensions` isolation and explicitly load only the audited bootstrap: `codex-multi-account`, `provider-routing`, then `codex-web-search`. This gives PI WEB workers the same Codex account/proxy transport capability as the parent (plus the `web_search` tool for delegated research) without loading arbitrary extensions.

GPT-5.6 Sol/Terra/Luna use the long-context overrides in `models.json`: both Codex OAuth accounts advertise a 1,000,000-token window to Pi, while the direct OpenAI API advertises its documented 1,050,000-token window. Codex App and CLI share the top-level `~/.codex/config.toml` settings `model_context_window = 1000000` and `model_auto_compact_token_limit = 900000`. A Codex runtime may report 828,400 usable input tokens after reserving output and its 95% safety budget; that is the effective input portion of the 1M total window, not a fallback to the old 272K tier. Requests that grow beyond 272K consume long-context quota at the applicable higher rate.

Useful commands:

```bash
pi-web status
pi-web doctor
pi-web version
pi-web logs
pi-web restart
```

### Private phone access with Tailscale

1. Install [Tailscale for macOS](https://tailscale.com/download/mac) and sign in.
2. Install Tailscale on the phone and sign in to the same Tailnet.
3. Run on the Mac:

```bash
~/.pi/agent/scripts/setup-pi-web-tailscale.sh
```

4. Open the private HTTPS URL printed by Tailscale on the phone. Test once over cellular data with Wi-Fi disabled.

Check or disable it later:

```bash
~/.pi/agent/scripts/setup-pi-web-tailscale.sh --check
~/.pi/agent/scripts/setup-pi-web-tailscale.sh --off
```

PI WEB has no general application-password layer. Tailnet identity and ACLs are the access boundary: enable MFA, allow only trusted devices/users, never expose port `8504` through the router, and never replace Serve with public `tailscale funnel`.

Keep the home Mac awake, let PI WEB and Tailscale start after reboot, and retain SSH/Tailscale SSH as a backup repair path. Runtime config, state, logs and Tailscale identity remain local under `~/.config/pi-web/`, `~/.pi-web/` and Tailscale; none are committed.

## Plan Mode

- `enter_plan_mode` blocks write tools and writes a branch-aware durable marker.
- `ask_user` displays interactive choices where supported.
- `exit_plan_mode` presents the complete plan for explicit approval.
- TUI uses its custom approval view; PI WEB/RPC uses browser confirm and optional feedback dialogs.
- Reject, cancel, feedback, JSON/print mode, or unavailable UI all fail closed and keep write access blocked.
- `/reload`, `/tree`, and `/rewind` reconstruct Plan Mode from the current branch; shutdown never silently turns it off.
- The PI WEB Activity panel displays a persistent PLAN chip, reason, and runtime liveness.

Manual commands: `/plan`, `/plan off`, `/plan <reason>`.

## Credential Security

- `auth.json` is local-only, ignored by Git, and must remain mode `600`.
- Never force-add `auth.json` with `git add -f`.
- Never paste complete API keys, OAuth access tokens, or refresh tokens into chat, issues, screenshots, logs, or documentation.
- Before committing, inspect staged content with `git diff --cached`.
- If a credential may have leaked, revoke or rotate it at the provider first, then update the local credential. Deleting a file or rewriting Git history does **not** invalidate an old token.
- If credentials entered Git history, remove them from all history and force-push, but still rotate every affected credential.
- For Codex OAuth exposure, revoke relevant sessions/authorization in account security settings and run `/login` again.

Use explicit paths when committing:

```bash
cd ~/.pi/agent
git status --short
git add <files-or-directories-to-commit>
git diff --cached
git commit -m "update: describe change"
git push origin main
```

Avoid an unchecked `git add -A`.

## Troubleshooting

### `Cannot find module .../pi-ai/dist/...`

Update the repository and restart pi:

```bash
cd ~/.pi/agent
git pull --rebase origin main
pi
```

Current extensions load `pi-ai` through pi's virtual module API rather than a hardcoded `~/.nvm/.../node_modules` path.

### `Cannot find module 'undici'`

The current provider transport treats `undici` as optional and uses its Node-core fallback when unavailable. If this error still appears, an old copy of `extensions/provider-routing/index.ts` is being loaded; update the repository and restart pi.

### `/model` returns to a flat model list after updating pi

An npm update replaced the patched package file. Re-run:

```bash
~/.pi/agent/scripts/apply-model-selector-patch.sh --check || \
  ~/.pi/agent/scripts/apply-model-selector-patch.sh
```

If the script reports an unsupported version or unknown hash, it has intentionally left the installation untouched; update the versioned patch before applying anything.

### Existing clone after security history rewrite

The repository history was rewritten to remove `auth.json`. For an old clone, the safest migration is a fresh clone. Preserve local-only configuration and credentials separately; never copy them back into Git tracking.
