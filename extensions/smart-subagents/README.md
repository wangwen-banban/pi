# Smart Sub Agents

Global pi extension for asynchronous, automatically routed sub-agents.

## What it does

- Classifies each delegated task as `simple`, `medium`, `complex`, or `critical`.
- Selects an authenticated model and supported thinking level from `~/.pi/agent/subagents.json`.
- Chooses `isolated`, `selected`, `summary`, or `full` parent-context inheritance.
- Runs each worker in an isolated `pi --mode json --no-session --no-extensions` process.
- Shares the parent's working directory while keeping conversation context isolated.
- Delivers completion immediately through lifecycle events and a visible `steer` message instead of polling. It enters at the next safe agent-loop boundary without aborting an in-flight response or tool call.
- Shows the effective model, thinking level, context mode, permission, and status in the TUI; completed rows disappear after 60 seconds.
- Serializes write agents whose declared `writeScope` values overlap.

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

Each run contains `context.md` and `result.json`.

## Inspecting a running agent

When the editor is empty and a sub-agent is visible, press `↓` to enter the Sub Agent browser. You can also run `/agents`.

- `↑` / `↓`: choose an agent
- `Enter` / `→`: open live details
- Detail view shows model, thinking, context, permission, task, assistant output and tool activity
- `↑` / `↓` or `PgUp` / `PgDn`: scroll live output
- `←`: return to the agent list
- `Esc` or `q`: close the browser

The detail view updates while the child is running. Completed agents remain inspectable during the 60-second hold period.

## Streaming input behavior

While the parent is generating:

- `Enter` submits the editor text as a steering message for the current turn.
- `Tab` submits non-empty editor text as a follow-up queued for the next turn.
- When pi is idle, `Tab` keeps its normal completion/indent behavior.

## Reload

Extension-only changes can use `/reload`. Core interactive-mode changes (including the streaming `Enter`/`Tab` behavior) require restarting pi. Configuration is re-read for every new dispatch.
