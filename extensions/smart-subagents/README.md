# Smart Sub Agents

Global pi extension for asynchronous, automatically routed sub-agents.

## What it does

- Classifies each delegated task as `simple`, `medium`, `complex`, or `critical`.
- Selects an authenticated model and supported thinking level from `~/.pi/agent/subagents.json`.
- Chooses `isolated`, `selected`, `summary`, or `full` parent-context inheritance.
- Runs each worker in an isolated `pi --mode json --no-session --no-extensions` process with a trusted provider bootstrap (see below).
- Works identically from native Pi and PI WEB sessions: embedded PI WEB runtimes resolve the standalone `pi` CLI instead of accidentally re-executing the hosting `sessiond.js`.
- Shares the parent's working directory while keeping conversation context isolated.
- Delivers completion immediately through lifecycle events and a visible `steer` message instead of polling. It enters at the next safe agent-loop boundary without aborting an in-flight response or tool call.
- Shows the effective model, thinking level, context mode, permission, status, and a live duration in the TUI; active rows refresh once per second and completed rows disappear after 60 seconds.
- Shares one stable editor-above activity stack with Background Tasks. Tasks is always above Sub Agents (with independent 10-line truncation), so timer refreshes cannot swap the two sections.
- Enforces a configurable hard wall-clock timeout, with `SIGTERM` then bounded `SIGKILL` escalation.
- Serializes write agents whose declared `writeScope` values overlap.

## Routing: main agent decides, the system backs it up

The router is advisory, not prescriptive. The main agent is told to inspect the
available model catalogue and route explicitly; `auto` fields are filled by the
background advisor (a lightweight classifier) and, failing that, deterministic
rules — dispatching never blocks.

### `list_subagent_models`

Call this to see which models are currently eligible for `delegate_subagent`
across all providers: strength tier, supported thinking levels, context window,
and registry pricing.

```text
Eligible sub-agent models: 8 · scope: session
REF | TIER | THINKING | CONTEXT | $IN/$OUT | NOTE
openai-codex/gpt-5.6-sol | S | low..xhigh | 1M tok | 1.75/14.00 | 最强推理…
```

- `filter` (provider/model/name/note keyword), `tier` (S/A/B/C), `maxRows`,
  and `offset` paginate large catalogues.
- Tiers are curated capability guidance, **not** benchmarks. `B*` marks an
  unprofiled model with the neutral default tier.
- Prices are registry USD per 1M tokens (in/out); `-` means free, local, or
  missing metadata.

### Strength tiers

`~/.pi/agent/subagents.json` can annotate models with a capability tier and a
note; unprofiled models get the neutral default (`B`):

```json
{
  "modelProfiles": {
    "defaultTier": "B",
    "models": {
      "openai-codex/gpt-5.6-sol":  { "tier": "S", "note": "最强推理，高风险/复杂任务" },
      "openai-codex/gpt-5.6-luna": { "tier": "A", "note": "快且便宜；开 max 思考后明显优于 5.5/5.4" },
      "openai-codex/gpt-5.4-mini": { "tier": "C", "note": "轻量快速，简单任务省钱" }
    }
  }
}
```

Context window, pricing, and supported thinking levels are always read live from
the model registry — never copied into the config.

### Context inheritance

| Mode | Meaning |
|---|---|
| `isolated` | No parent conversation inherited (task/notes/files still pass) |
| `selected` | The most recent `context.selectedMessages` parent messages (default 6) |
| `summary` | Distilled parent context from the advisor; falls back to `selected` when distillation is unavailable |
| `full` | The parent's full effective conversation, capped by `context.maxFullChars` |

`contextFiles` no longer forces `isolated` up to `selected`; explicit files are
passed in every mode.

## Agent tool

The parent model receives `delegate_subagent` automatically. Its routing fields default to `auto`:

- `model`
- `effort`
- `complexity`
- `contextMode`
- `permission`

Useful context fields:

- `contextFiles`: paths relevant to the task
- `contextNotes`: decisions or constraints needed by the worker
- `writeScope`: files/directories the worker may modify
- `expectedOutput`: acceptance criteria

The tool returns after routing and process creation. The parent should not wait or poll. A terminal completion message is injected automatically when the child exits. If the parent is busy, it enters the steering queue and is consumed after the current model response/tool batch, before the next model call.

Guidance to the main agent: consult `list_subagent_models` before quality- or
cost-sensitive dispatches, pass `model`/`effort`/`contextMode`/`permission`
explicitly when the catalogue makes a clear fit, and pick the least costly
model that safely meets the task — the highest tier is not the default choice.
Fields left `auto` are still filled fail-open by the advisor and rules.

## Execution lifecycle and timeouts

```json
{
  "execution": {
    "hardTimeoutMs": 1800000,
    "terminateGraceMs": 5000
  }
}
```

The default hard cap is **30 minutes**. This contains stuck/orphaned workers while
leaving substantial headroom for `max`-thinking tasks; it is a wall-clock cap,
not an idle-output timeout, so long silent reasoning is not mistaken for a hang.
Values are clamped to 1 minute–24 hours; termination grace is clamped to
100 ms–60 seconds.

At the cap, the worker receives `SIGTERM`, then `SIGKILL` if it is still alive
after the grace period. The durable result is `status: "failed"` with
`terminationReason: "timed_out"` and names `execution.hardTimeoutMs` as the
setting to adjust. External signals are failures; `/agents stop` is an explicit
`stopped` result. A null exit code can never be interpreted as completion.

The duration widget uses a single unreferenced one-second timer only while a job
is routing, queued, or running. It stops when no job is active and is always
cleared during session shutdown or extension reload.

Session shutdown finalizes every routing, queued, and running job as durable
`stopped` state before teardown. It writes `result.json` even when routing had
not yet produced `context.md`, and intentionally uses a persistence-only path:
no stale UI, completion message, or lifecycle hook is required to save it.
Running children receive `SIGTERM` and then `SIGKILL` after the configured grace
if needed.

## Worker provider bootstrap

Workers keep `--no-extensions`, so they do not inherit the parent's extension
set. Dynamic providers (the secondary Codex OAuth account and the routed Codex /
Claude relays) are re-registered through a small, fixed, audited bootstrap:

```json
{
  "execution": {
    "workerExtensions": ["codex-multi-account", "provider-routing", "codex-web-search"]
  }
}
```

- Values are **symbolic keys only** — never paths. The table maps them to
  `extensions/codex-multi-account/index.ts` (order 0),
  `extensions/provider-routing/index.ts` (order 1), and
  `extensions/codex-web-search/index.ts` (order 2) under the agent directory.
- The provider pair is required in this order for the secondary account:
  `provider-routing` alone leaves `openai-codex-second` without oauth/models.
- `codex-web-search` gives every worker the `web_search` tool (Codex search
  with the Exa free fallback). It is loaded after the provider bootstrap and
  is included in the worker `--tools` allowlist for both read-only and
  workspace-write dispatches.
- Keys are deduped and forced into the fixed order; unknown or path-shaped
  config entries are ignored and can never become load paths. Files are
  realpath-verified regular files inside the extensions directory before
  dispatch, so a missing/moved/compromised trusted file fails with a
  `routing_error` before any worker spawns.
- Providers supplied/routed by the bootstrap (`openai-codex`,
  `openai-codex-second`, and `claude-custom`) are preflighted
  against the configured keys without any network call; unrelated builtin
  providers continue to work.
- The unsupported-model fallback is the only automatic retry. It never runs
  after tool activity or file edits, and a generic `fetch failed` never
  silently falls back — it surfaces a bounded diagnostic instead.
- Global `models.json` overrides give GPT-5.6 Sol/Terra/Luna a 1M Codex
  context window for both OAuth accounts. Workers inherit those overrides even
  under `--no-extensions`; the trusted bootstrap only restores provider and
  transport registration. Routing uses Luna for simple work, Terra for normal
  work, and Sol for complex/critical work.

## Commands

```text
/agents
/agents stop <task-name-or-id>
/agents clear
/agents config
```

## Lifecycle hooks

The extension emits these event-bus events:

```text
smart-subagent:started
smart-subagent:progress
smart-subagent:completed
smart-subagent:failed
smart-subagent:stopped
```

Other pi extensions can subscribe with `pi.events.on(...)`.

External shell hooks can be configured in `~/.pi/agent/subagents.json`:

```json
{
  "hooks": {
    "completed": ["~/.local/bin/on-subagent-complete"],
    "failed": ["~/.local/bin/on-subagent-failed"]
  }
}
```

Each hook receives the event JSON on stdin and these environment variables:

```text
PI_SUBAGENT_EVENT
PI_SUBAGENT_ID
PI_SUBAGENT_NAME
PI_SUBAGENT_MODEL
PI_SUBAGENT_EFFORT
```

Hooks are observational: failures and timeouts do not block completion delivery.

## Run records

Context packets and full results are stored with user-only permissions under:

```text
~/.pi/agent/subagent-runs/<parent-session-id>/<subagent-id>/
```

A started run contains `context.md` and `result.json`. If the parent shuts down
while a job is still routing, `result.json` is still written with
`status: "stopped"`; `context.md` may legitimately not exist yet.

## Inspecting a running agent

When the editor is empty and a sub-agent is visible, press `↓` to enter the Sub Agent browser. You can also run `/agents`.

- `↑` / `↓`: choose an agent
- `Enter` / `→`: open live details
- Detail view shows model, thinking, context, permission, task, assistant output and tool activity
- `↑` / `↓`: scroll live output one line
- `PgUp` / `PgDn`, or macOS `Option+↑` / `Option+↓`: scroll by page
- `Home` / `End`: jump to the beginning / latest output
- `←`: return to the agent list
- `Esc` or `q`: close the browser

The detail view updates while the child is running. Completed agents remain inspectable during the 60-second hold period.

## Streaming input behavior

While the parent is generating:

- `Enter` submits the editor text as a steering message for the current turn.
- `Tab` submits non-empty editor text as a follow-up queued for the next turn.
- When pi is idle, `Tab` keeps its normal completion/indent behavior.

## PI WEB compatibility

PI WEB embeds the Pi SDK inside its session daemon, so `process.argv[1]` points to
`pi-web/dist/server/sessiond.js`, not the Pi CLI. PI WEB marks that environment
with `PI_WEB_SESSION=1`; the worker launcher uses this marker to invoke the
standalone `pi` command from `PATH`. The child still inherits the configured
`PI_CODING_AGENT_DIR`, authentication, model registry, working directory, and
worker arguments, matching native Pi dispatch behavior without starting or
connecting to another PI WEB daemon.

After changing this extension, run the **`/reload` command** inside the PI WEB
session. That command clears Pi's extension cache and rebuilds the runtime; the
sidebar **Reload Session** action only reopens the session JSONL and may reuse a
cached extension factory. The session daemon itself does not need to restart.

## Reload

Extension-only changes can use `/reload`. Core interactive-mode changes (including the streaming `Enter`/`Tab` behavior) require restarting pi. Configuration is re-read for every new dispatch.
