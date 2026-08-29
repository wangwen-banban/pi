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
then `SIGKILL` after a five-second grace period if needed.

## Completion behavior

Any terminal result updates the plan and wakes the main model:

- exit 0 → `completed`
- non-zero exit, signal, spawn failure, wall timeout or health-policy expiry → `failed`
- restart with lost process ownership → `failed` (`monitor_restarted`)
- explicit stop → `cancelled`
- graceful session shutdown/reload → `blocked`

Before delivery, the terminal result, terminal task-plan revision, and a
per-run pending-wake marker are appended durably. The wake uses
`triggerTurn: true` and `deliverAs: "followUp"`. If the main model is responding
to another user prompt, completion waits for `agent_settled` (after retries,
auto-compaction, and queued continuations), not merely a low-level `agent_end`.
Completions arriving together are coalesced. The injected message uses the
latest task-plan revision, so a user reprioritization made while the command ran
determines the next pending task.

A successful assistant response acknowledges each durable run id. Normal
runtime delivery is deduplicated; if Pi exits after terminal persistence but
before acknowledgement, session reconstruction safely replays the same id. A
persisted assistant response also acts as an implicit acknowledgement for the
small crash window before the explicit acknowledgement marker. On restart, an
`in_progress` plan with a valid terminal `result.json` is finalized from that
result. If no terminal result exists, ownership cannot safely be reattached, so
the run fails closed with `monitor_restarted` and wakes recovery instead of
remaining `in_progress` forever. Graceful reload/shutdown still stops owned
processes and marks their tasks `blocked` without a completion wake.

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
append-only transcript, completion message, and private result logs retain the
audit trail. The PI WEB Activity panel reads a privacy-trimmed record and shows
task ids/statuses plus managed-run timing.

## Storage and privacy

Full private run data is stored under:

```text
~/.pi/agent/background-task-runs/<session-id>/<run-id>/
```

Directories are `0700`; metadata, result and log files are `0600`. Console logs
are capped. Pending/acknowledged wake markers are branch-aware session custom
entries and do not enter model context. The workspace Activity registry
contains no command, full task title, output, progress token, credentials,
parent context or PID—only short ids/names, lifecycle/health status, revision
and timestamps.

The task plan and wake outbox are session custom entries and follow `/tree`,
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
