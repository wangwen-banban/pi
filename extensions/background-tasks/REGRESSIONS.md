# Background-task regressions

## 2026-08 — alive adoption watcher prevented recovery wake

### Incident (sanitized)

A Pi-managed local adoption watcher followed two remote evaluation supervisors.
Both supervisors terminated with `BrokenPipeError`, and the remote accelerators
became idle. A quoting/probe defect made every local SSH status check resolve to
`unavailable`. The watcher printed that state on every iteration but had no
bounded unavailable or stale-progress rule, so its shell process stayed alive
under a long wall timeout. Because the managed process never became terminal,
Pi had no lifecycle completion to inject and the main agent received no
recovery turn. Explicitly stopping the watcher immediately produced the normal
`stopped by user` lifecycle update, confirming that the existing terminal hook
was working.

No hostnames, credentials, private commands, or evaluation payloads are recorded
here.

### Two failure classes

1. **Known terminal event, wake not yet delivered.** A result exists, but Pi can
   exit between result/plan persistence and the model's recovery response. This
   is a delivery/restart problem.
2. **Monitor never reaches terminal.** A local watcher remains alive while its
   observed work is indefinitely unavailable or stale. There is no terminal
   event to wake from. This was the incident's primary trigger.

Treating (2) as a lost terminal hook is incorrect: replay cannot recover an
event that never existed. Conversely, a health timeout alone does not close the
crash windows in (1).

### Correction and invariant

- `run_background_task.healthPolicy` is an opt-in lease contract. The child
  writes versioned JSON Lines records to dedicated fd 3. Local monotonic
  deadlines bound startup silence, heartbeat silence, continuous
  `unavailable`, and optionally unchanged healthy progress. Human output is
  never parsed and brief outages get an explicit recovery window.
- Health-policy expiry terminates the owned process group through the existing
  TERM→KILL path and records `health_policy_failed`, creating an ordinary
  terminal lifecycle event.
- Every wakeable terminal result requires durable plan and pending markers
  before delivery. Each send has an explicit delivery id, attempt, run ids and
  sequences. Only the matching agent run's final `stop` response at an idle
  settle can append an acknowledgement; no later assistant message is an
  implicit ack. Missing starts and failed responses release dedupe for bounded-
  backoff retry.
- Restart reconstruction finalizes an `in_progress` task only from a strict,
  session-bound v3 terminal manifest. Lost ownership without a terminal result
  fails closed as `monitor_restarted`; invalid terminal evidence is surfaced as
  `recovery_blocked`. Pi never guesses or reattaches to a process id.
- TERM→KILL finalization waits for child `close`. Signal failure or a missing
  close becomes `termination_unconfirmed`, never a fabricated stopped/timeout
  result.
- Durable run/session/web records contain no commands, paths, titles, output,
  credentials, parent context, PID, or start token. No stdout/stderr logs exist.
- Task-plan revisions remain optimistic: completion/recovery increments the
  current revision, stale model updates are rejected, and wake delivery reads
  the latest revision.

**Invariant:** managed work with an opted-in health policy cannot remain
`in_progress` beyond its declared health/progress bounds, and once a wakeable
terminal state is durably recorded its run id is delivered once in normal
operation or replayed idempotently after restart until acknowledged.

### Compatibility

Existing calls without `healthPolicy` retain process-exit/signal/wall-timeout
semantics. Text such as `unavailable` remains ordinary output. Legacy/full run
records are intentionally rejected rather than trusted for recovery; their
terminal plans produce an explicit blocked recovery notice.

### Regression coverage

- normal success, non-zero exit, external signal, explicit stop, wall timeout,
  and TERM→KILL cleanup;
- legacy alive monitor output versus structured fail-closed unavailable state;
- transient unavailable→healthy recovery and sustained unavailable/stale
  progress;
- malformed/missing heartbeat policy records;
- strict manifest recovery, lost ownership, blocked invalid recovery, pending
  replay, explicit acknowledgement/deduplication, watchdogs, and latest-plan
  revision races;
- append failure sends zero, tool/error responses never ack, nested busy settles
  never flush, and shutdown/branch changes cancel retry;
- recursive durable-data privacy scans, symlink/traversal/mode/session/schema/
  stale/coherence rejection, and privacy-safe PI WEB health projection.
