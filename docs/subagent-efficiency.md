# Incremental subagent efficiency

Workers keep Pi's independent process, in-memory session, provider and cache
behavior. No parent session ID, connection, KV state or full native conversation
fork is shared. Model choices, thinking levels, concurrency and limits are unchanged.

Context inheritance uses `buildContextEntries()` rather than the raw branch:
compacted-away messages stay omitted, retained messages appear once, and active
compaction/branch summaries are preserved. This remains a text projection of
user/assistant messages plus summaries, not a copy of raw tool/image/reasoning
history. An effective-context read error stops dispatch rather than falling back
to stale raw history. Explicit `isolated` skips parent-history extraction entirely,
even when an advisor is still needed for other `auto` fields.

Character caps select recent evidence rather than the conversation's beginning.
If a long assistant response would displace the latest user message in the selected
set, up to half the available character budget is reserved for that user message.
The cap is not expanded; large messages can still be truncated. For `selected`,
the configured message count is applied first. Put indispensable constraints in
`contextNotes` and `expectedOutput`, not solely in a long historical message.

The advisor is skipped when `contextMode` and `permission` are explicit, no
`summary` is requested, and either `complexity` is explicit (the existing fast
path) or both `model` and `effort` are explicit. The latter matches normal
main-agent routing without paying for classification that cannot change execution.
`auto` remains supported, summary requests still use the advisor, and failures
still use the existing deterministic fallback. No confidence classifier or extra
model call was added. The advisor's existing retention/identity policy is unchanged.

Worker prompts put stable rules and unchanged permission/scope constraints first,
shared reference context next, then task-specific files/notes. Operational job IDs,
display names and model/effort/routing diagnostics remain in logs/UI rather than
preceding the shared context. Authority is never weakened to improve prefix matching.
This removes avoidable prefix differences; it does not guarantee cross-worker
cache hits or prove a fixed percentage of credit savings.

Offline checks (Node 22.19+, with Pi 0.84.1 globally installed for integration):

```sh
node --experimental-strip-types --test extensions/smart-subagents/test-context*.mjs
```

The unit tests need no model runtime. Integration tests exercise the actual Pi
SessionManager and production preparation functions with a mocked provider;
no live model requests or actual cache-hit/credit measurements are performed.

