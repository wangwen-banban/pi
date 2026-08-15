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
| `btw` | Disposable multi-turn side conversations with optional `/keep` persistence |
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

- `enter_plan_mode` blocks write tools.
- `ask_user` displays interactive choices.
- `exit_plan_mode` presents a plan for approval.
- Approval restores write access.

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
