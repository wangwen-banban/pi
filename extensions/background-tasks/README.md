# Main-agent Background Tasks

Managed long-running shell commands with a dynamic, Codex-style task plan and
an event-driven main-agent wakeup.

## Why

A normal Pi `bash` tool call waits for the command. A raw `cmd &`, `nohup`, or
`disown` returns immediately but loses a trustworthy completion handle, so the
main model cannot know when to continue without polling. This extension owns
the process from launch through exit and injects one lifecycle message when it
finishes. Sanitized incident history and regression invariants are recorded in
[`REGRESSIONS.md`](REGRESSIONS.md).

## Tools

### `update_task_plan`

Maintains an ordered, branch-aware plan:

```text
○ benchmark · pending
○ analyze   · pending
○ report    · pending
```

Every update carries `baseRevision`. Background completion and user-driven
updates both increment the revision; a stale update is rejected with the latest
plan instead of overwriting a completion that raced it.

The plan is deliberately dynamic. New user prompts can add, cancel, rename or
reprioritize pending work while a command is running. The active managed task
cannot be silently removed or marked complete by a plan update.

### `run_background_task`

Starts an arbitrary shell command and returns immediately:

```json
{
  "taskId": "benchmark",
  "name": "benchmark",
  "command": "python scripts/benchmark.py --output results.json",
  "cwd": ".",
  "timeoutMs": 21600000
}
```

The extension monitors output, exit code, signal and wall timeout. The managed
command must remain in the foreground of its shell; use a server's
`--no-daemon`/foreground mode when applicable. Do not use raw `&`, `nohup`,
`disown`, daemonizing flags, or PID polling for work that needs this lifecycle
hook.

#### Opt-in fail-closed health/progress policy

A local process can remain alive even though the remote work it watches is
unavailable or no longer progressing. Pi cannot infer those application
semantics from human console text. Watchers and adoption monitors should opt in
to an explicit policy:

```json
{
  "taskId": "adopt-remote-run",
  "command": "./watch-remote-run.sh",
  "timeoutMs": 21600000,
  "healthPolicy": {
    "startupGraceMs": 60000,
    "heartbeatTimeoutMs": 120000,
    "unavailableTimeoutMs": 600000,
    "staleProgressTimeoutMs": 1800000
  }
}
```

With `healthPolicy`, the child receives a dedicated control pipe as file
descriptor 3 and `PI_BACKGROUND_TASK_HEALTH_FD=3`. It writes one JSON object per
line (maximum 16 KiB):

```sh
# Successful probe; change progress whenever application progress advances.
printf '%s\n' '{"version":1,"health":"healthy","progress":"step-42"}' >&3

# Probe could not establish health. Repeated reports remain heartbeats but do
# not hide a sustained outage.
printf '%s\n' '{"version":1,"health":"unavailable"}' >&3
```

The runner uses local receipt time and a monotonic clock; child timestamps are
neither needed nor trusted. The contract is:

- the first valid record must arrive within `startupGraceMs` (defaults to
  `heartbeatTimeoutMs`);
- silence after a valid record is bounded by `heartbeatTimeoutMs`;
- continuously reported `unavailable` health is bounded by
  `unavailableTimeoutMs`;
- when `staleProgressTimeoutMs` is present, an unchanged/missing progress token
  is bounded while health is `healthy`;
- stale progress is terminalized while health is `healthy`; recovery with an
  unchanged token retains its prior progress age, so availability flapping
  cannot reset the bound. Size the stale window to tolerate brief outages;
- malformed records fail closed as a protocol error.

All windows are explicit, from 1 second through 7 days. Omitting
`healthPolicy` preserves the old process-lifecycle behavior: log lines such as
`unavailable` have no special meaning, so existing commands remain compatible.

### `stop_background_task`

Stops an exact run id or task id. The owned process group receives `SIGTERM`,
then `SIGKILL` after a five-second grace period if needed. A KILL request is not
a terminal result: the runner still waits for child `close`. If close never
arrives within the bounded confirmation window, the honest terminal class is
`termination_unconfirmed`, not `stopped` or `timed_out`.

## Completion behavior

Any terminal result updates the plan and wakes the main model:

- exit 0 → `completed`
- non-zero exit, signal, spawn failure, wall timeout or health-policy expiry → `failed`
- restart with lost process ownership → `failed` (`monitor_restarted`)
- unsafe/missing terminal recovery evidence → `blocked` (`recovery_blocked`)
- TERM/KILL without observed close → `failed` (`termination_unconfirmed`)
- explicit stop → `cancelled`
- graceful session shutdown/reload → `blocked`

Before delivery, the terminal task-plan revision and a per-run pending marker
must both append successfully. Every send then appends a delivery marker binding
the exact session, random delivery id, attempt, run ids, and run sequences. The
wake uses `triggerTurn: true` and `deliverAs: "followUp"`. Persistence failure
sends nothing and leaves bounded-backoff in-memory retry state. Missing
`agent_start`/message delivery is detected by a watchdog and releases queue
deduplication for another explicit attempt.

If the main model is responding to another prompt, completion waits for an
`agent_settled` event whose `ctx.isIdle()` is actually true. Completions arriving
together are coalesced, and the injected message uses the latest plan revision.
Only the matching delivery's final assistant response with `stopReason=stop`
can append an explicit acknowledgement at an idle settle. `toolUse`, `length`,
`error`, and `aborted` never acknowledge; later unrelated successful turns do
not repair a failed attempt. Branch changes and shutdown cancel old-session
watchdogs and retries. There is deliberately no implicit assistant-message ack.

On restart, an `in_progress` plan with a valid, session-bound v3 terminal
`result.json` is finalized from that manifest. A missing unowned result becomes
`monitor_restarted`. A terminal plan whose manifest is missing, malformed,
stale, mismatched, symlinked, or incorrectly permissioned becomes an explicit
`recovery_blocked` result and durable wake rather than being silently skipped.
Graceful reload/shutdown stops owned processes without waking the old session.

## Commands and UI

```text
/tasks
/tasks stop <run-id-or-task-id>
/tasks stop all
/tasks clear-completed
```

The task plan is a current-goal view, not a permanent history log. On each
`update_task_plan`, the model should omit terminal or obsolete tasks that no
longer materially affect the next analysis, retry, verification, or decision;
omitted non-active tasks disappear from the latest marker, system prompt,
`/tasks`, and PI WEB projection. An active managed run can never be omitted.
Terminal tasks kept because they remain relevant stay in the compact TUI/PI WEB
display briefly (completed rows age out visually after 60 seconds). The
append-only transcript and bounded completion message retain the model-facing
audit trail. The PI WEB Activity panel reads a privacy-trimmed record and shows
task ids/statuses plus managed-run timing.

## Storage and privacy

A privacy-minimal terminal manifest is stored under:

```text
~/.pi/agent/background-task-runs/<session-id>/<random-run-id>/result.json
```

Directories are strict `0700` and the manifest is strict `0600`. Run ids are
cryptographically random; atomic temporary names use cryptographic nonces and
never PIDs. Storage creation is exclusive, rejects symlinks/non-regular files,
checks realpath containment and ownership/modes, and fails closed on any
permission or atomic-publication error. No metadata sidecar, `stdout.log`, or
`stderr.log` is created. Command, cwd/path, title, credentials, output/tails,
parent context, PID, and process start tokens are never written to run storage,
session markers, or PI WEB records. Console output exists only as a bounded
in-memory tail and in the one current completion message when needed.

The v3 terminal manifest contains only session/run/task bindings, terminal
status/classification, bounded timestamps, exit/signal flags, and health timing
metadata. Legacy/full snapshots, stale or incoherent records, and identity
mismatches are rejected. Privacy-minimal v2 plan/wake markers are branch-aware
session custom entries and do not enter model context.

The task plan and wake outbox follow `/tree`,
`/rewind`, `/sync`, and reload reconstruction. Active runs and unacknowledged
completion wakes block branch/session switches. Browser disconnects do not stop
a PI WEB session runtime. `/reload`, session close/archive, or TUI exit safely
terminate owned active runs; an abrupt runtime loss is detected and terminalized
on the next session start rather than silently reattaching a possibly reused
process id.

## Hooks

Other extensions may subscribe to:

```text
background-task:started
background-task:progress
background-task:completed
background-task:failed
background-task:stopped
```

Hooks are observational and cannot override lifecycle finalization.
