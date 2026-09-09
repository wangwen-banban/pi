# Smart Sub Agents

> Native history forks, Spark routing and cache compatibility are described in
> [native-subagent-forks.md](../../docs/native-subagent-forks.md).

Global pi extension for asynchronous, automatically routed sub-agents.

## What it does

- Classifies each delegated task as `simple`, `medium`, `complex`, or `critical`.
- Selects an authenticated model and supported thinking level from `~/.pi/agent/subagents.json`.
- Chooses `fork_turns`: `all`, `none`, recent N user turns, or `auto`; old context modes are compatibility aliases.
- Runs each worker in an independent Pi process with a private native session seed for inherited context, or `--no-session` for no inheritance, and a trusted bootstrap.
- Works identically from native Pi and PI WEB sessions: embedded PI WEB runtimes resolve the standalone `pi` CLI instead of accidentally re-executing the hosting `sessiond.js`.
- Shares the parent's working directory while keeping conversation context isolated.
- Delivers completion through lifecycle events and a visible follow-up message instead of polling, without aborting an in-flight response or tool call.
- Shows the effective model, thinking level, context mode, permission, status, and a live duration in the TUI; active rows refresh once per second and completed rows disappear after 60 seconds.
- Shares one stable editor-above activity stack with Background Tasks. Tasks is always above
  Sub Agents (with independent 10-line truncation), so timer refreshes cannot swap the two
  sections. During a Plan Mode question/approval on Pi 0.84.1, presentation stays on its current
  snapshot while agent state and timers continue; closing the dialog flushes the latest ordered
  stack once.
- Enforces a configurable hard wall-clock timeout, with `SIGTERM` then bounded `SIGKILL` escalation.
- Serializes write agents whose declared `writeScope` values overlap.

## Routing: main agent decides, the system backs it up

The lightweight `openai-codex/gpt-5.3-codex-spark` selector sees bounded task data,
model descriptors and parent context metadata, not raw parent history. It selects
model, supported thinking effort and fork scope. Fully explicit execution choices
skip the selector. Unavailable Spark, invalid output or timeout uses deterministic
rules with a recorded reason, never a silent main-model classification call.
Permissions remain independent of the selector. Invalid explicit context or model
requests can fail dispatch rather than silently discarding required evidence.

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

| `fork_turns` | Meaning |
|---|---|
| `none` | No parent history; explicit task, notes and file paths still pass |
| positive integer string | Recent user-message turns, preserving a current compaction summary |
| `all` | Frozen native effective history with complete historical tool call/result pairs |
| `auto` | Router suggestion checked against model, modality and context budgets |

Old `contextMode` aliases remain accepted: isolated=none, selected=recent turns,
summary/full=all. No summarizer runs. Explicit oversized all/N requests fail;
auto can narrow at turn boundaries. Imported history is reference, not authority.
See the native-fork guide for budget migration and cache-hit limitations.

## Agent tool

The parent model receives `delegate_subagent` automatically. Its routing fields default to `auto`:

- `model`
- `effort`
- `complexity`
- `fork_turns` (`contextMode` is deprecated)
- `permission`

Useful context fields:

- `contextFiles`: paths relevant to the task
- `contextNotes`: decisions or constraints needed by the worker
- `writeScope`: files/directories the worker may modify
- `expectedOutput`: acceptance criteria

The tool returns after routing and dispatch. The parent should not poll. A terminal completion message is queued automatically when the child exits; while the parent is active, delivery is deferred until its `agent_end` boundary and uses the follow-up queue.

Guidance to the main agent: consult `list_subagent_models` before quality- or
cost-sensitive dispatches, pass `model`/`effort`/`fork_turns`/`permission`
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
not yet produced a private fork seed, and intentionally uses a persistence-only path:
no stale UI, completion message, or lifecycle hook is required to save it.
Running children receive `SIGTERM` and then `SIGKILL` after the configured grace
if needed.

At the next `session_start`, the extension scans only
`sessionManager.getBranch()` (the active branch, in branch order) for each job's
latest durable state. A latest `stopped` / `session_shutdown` state without a
valid completion message on that branch receives one recovered `stopped`
completion; no worker is restored or restarted. Existing completion messages
are hydrated as delivered, so a repeated start or `/reload` does not replay the
same branch again. Forks are isolated by their own active-branch history.

Recovery is intentionally **shutdown-only**. It does not synthesize completion
for `/agents stop` (`explicit_stop`), `completed`, or `failed` states, so it does
not widen normal completion crash windows. Parsing is fail-closed and bounded:
identifiers, names, routing metadata/enums, strings, paths, arrays, nesting,
entry/total bytes, and tracked jobs are validated, and at most 64 latest states
are replayed. Recovered details contain only validated id/name, status,
timestamps, shutdown reason, and optional routing metadata. They never copy the
historical task, expected output, context or scope paths, cwd, output/error,
progress, changed files, or run-log path; the displayed stopped reason is fixed
extension text.

Delivery uses an in-memory pending claim. A synchronous `sendMessage` throw
releases the claim for a later start, and a completion deferred while the parent
agent is active is marked delivered only after the `agent_end` send returns.
Shutdown abandons unsent deferred claims. Pi's extension API exposes
`sendMessage` as synchronous `void`, however, so a later failure inside its
fire-and-forget async implementation cannot be observed here; this mechanism
must not be treated as durable exactly-once delivery for that async failure
window.

## Worker provider bootstrap

Workers keep `--no-extensions`, so they do not inherit the parent's extension
set. Dynamic providers (the secondary Codex OAuth account, `claude-custom`, and
the two Cambricon NewAPI aliases) are re-registered through a small, fixed,
audited bootstrap:

```json
{
  "execution": {
    "workerExtensions": ["codex-multi-account", "provider-routing", "codex-web-search", "subagent-context"]
  }
}
```

- Values are **symbolic keys only** — never paths. The table maps them to
  `extensions/codex-multi-account/index.ts` (order 0),
  `extensions/provider-routing/index.ts` (order 1),
  `extensions/codex-web-search/index.ts` (order 2), and
  `extensions/smart-subagents/worker-context.ts` (order 3) under the agent directory.
- `subagent-context` is mandatory for native-fork workers. It adds no tools,
  enforces the delegated tool boundary and conditionally sets only the cache key.
  It never shares the main connection/session or treats history as new permission.
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
  `openai-codex-second`, `claude-custom`, `claude-cambricon`, and
  `cambricon-codex`) are preflighted against the configured keys without any
  network call; unrelated builtin providers continue to work.
- The unsupported-model fallback is the only automatic retry. It never runs
  after tool activity or file edits, and a generic `fetch failed` never
  silently falls back — it surfaces a bounded diagnostic instead.
- Global `models.json` overrides give GPT-5.6 Sol/Terra/Luna and GPT-6 Astra a
  1M context window for both OAuth accounts. Workers inherit those overrides
  even under `--no-extensions`; the trusted bootstrap only restores provider
  and transport registration. The lightweight selector chooses among the eligible catalogue; deterministic
  model routes remain configured fallbacks, not a guarantee that every provider
  or requested model is available on a given account.

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

Run results are stored with user-only permissions under:

```text
~/.pi/agent/subagent-runs/<parent-session-id>/<subagent-id>/
```

`result.json` records separate router/worker usage and effective fork selection.
During execution, exclusive `0600` files hold the native seed, system prompt and
metadata. They are removed on child close/startup failure; abrupt parent/OS death
can leave private ignored artifacts. The parent's live JSONL is never opened for
writing. Cache diagnostics count grouping decisions, not measured cache hits.
Routing/queued shutdown still writes stopped state even if no seed was created.

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
