# Stable prompt prefixes and explicit thinking selection

## Changes

Dynamic task-plan revisions and Plan Mode status are appended as hidden custom
messages rather than modifying `systemPrompt`. The latest snapshot of each type
is compared with `sessionManager.buildContextEntries()`, the active,
compaction-aware view in Pi 0.84.1. Durable state-only markers do not suppress a
model-visible snapshot. Earlier messages are not rewritten or removed.

Unchanged state is not appended again. Changed state, branch navigation,
compaction and aborted prompt preflight are handled without a process-local
"already sent" flag. Compaction recovery restores a missing snapshot using
`triggerTurn: false`, including continuations without `before_agent_start`.
Task tool results and completion messages still provide mid-turn state updates.

Plan Mode now reports both active and inactive state without replacing the
original system prompt. The existing tool guards, approval UI, read-only checks,
subagent restrictions and durable permission markers are unchanged. An inactive
snapshot does not grant additional permission.

Selecting either Codex provider no longer forces `xhigh`; Fast availability is
still refreshed. The configured default `xhigh` remains unchanged. This patch
does not alter model selection, context limits, compaction thresholds, cache
retention, OAuth, Fast tier, subagents, BTW sessions or usage accounting.

## Validation

With Node.js 22.19+:

```sh
node --experimental-strip-types --test scripts/test-cache-prefix.mjs
```

With the repository's Pi 0.84.1 installed globally, also run the real
SessionManager checks and existing extension regression suites:

```sh
node --experimental-strip-types --test scripts/test-cache-prefix-pi.mjs
node --experimental-strip-types --test --test-concurrency=2 extensions/*/test-*.mjs
```

The isolated suite checks snapshot identity, state changes, branch/compaction
recovery, prompt composition and preservation of the user's thinking selection.
The Pi suite uses actual SessionManager entries and compaction. These tests do
not contact model providers or measure server-side cache hits or account credits.
Current shutdown-replay implementation and tests are preserved unchanged.
Main already includes recovery fixes beyond the historical PR #2 description.

A temporary read-only workflow exports the eight candidate files and full test
results for review. It has no repository write permission and does not publish
code or delete branches. Baseline failures are retained, not converted to passes.
The BTW live-model smoke is not run without real model credentials. Mock-child
tests use a bounded test-only lifetime because the fake child has no OS handle.

## Runtime comparison

Finish active delegated/background work before `/reload`, following the existing
lifecycle requirements. Check `/plan on` and `/plan off`, task revision changes,
compaction and model switching. Writes must remain blocked in active Plan Mode.
For cost comparisons, keep model, account, effort and service tier identical.
Inspect per-request uncached input, cached input and output/reasoning usage;
reasoning is part of output, not an additional total. Removing avoidable prefix
changes is not a guarantee of cache hits or a measured saving percentage.
