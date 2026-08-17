# Main-agent Background Tasks

Managed long-running shell commands with a dynamic, Codex-style task plan and
an event-driven main-agent wakeup.

## Why

A normal Pi `bash` tool call waits for the command. A raw `cmd &`, `nohup`, or
`disown` returns immediately but loses a trustworthy completion handle, so the
main model cannot know when to continue without polling. This extension owns
the process from launch through exit and injects one lifecycle message when it
finishes.

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

The extension monitors output, exit code, signal and timeout. The managed
command must remain in the foreground of its shell; use a server's
`--no-daemon`/foreground mode when applicable. Do not use raw `&`, `nohup`,
`disown`, daemonizing flags, or PID polling for work that needs this lifecycle
hook.

### `stop_background_task`

Stops an exact run id or task id. The owned process group receives `SIGTERM`,
then `SIGKILL` after a five-second grace period if needed.

## Completion behavior

Any terminal result updates the plan and wakes the main model:

- exit 0 → `completed`
- non-zero exit, signal, spawn failure or timeout → `failed`
- explicit stop → `cancelled`
- session shutdown/reload → `blocked`

The wake uses `triggerTurn: true` and `deliverAs: "followUp"`. If the main model
is responding to another user prompt, completion waits for the safe
`agent_end` boundary. Completions arriving together are coalesced. The injected
message uses the latest task-plan revision, so a user reprioritization made
while the command ran determines the next pending task.

## Commands and UI

```text
/tasks
/tasks stop <run-id-or-task-id>
/tasks stop all
/tasks clear-completed
```

The TUI widget shows pending, in-progress and terminal task history. The PI WEB
Activity panel reads a privacy-trimmed record and shows task ids/statuses plus
managed-run timing.

## Storage and privacy

Full private run data is stored under:

```text
~/.pi/agent/background-task-runs/<session-id>/<run-id>/
```

Directories are `0700`; metadata, result and log files are `0600`. Console logs
are capped. The workspace Activity registry contains no command, full task
title, output, credentials, parent context or PID—only short ids/names, status,
revision and timestamps.

The task plan itself is a session custom entry and follows `/tree`, `/rewind`,
`/sync`, and reload reconstruction. Active runs block branch/session switches.
Browser disconnects do not stop a PI WEB session runtime, but `/reload`, session
close/archive, or TUI exit safely terminate active runs in this first version.

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
