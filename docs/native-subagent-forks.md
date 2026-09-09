# Native subagent forks and a lightweight Spark selector

Subagents remain independent Pi processes. The harness captures the current
compaction-aware context once, before the routing request, and creates a fresh
private Pi v3 session for the child. It does not open, append to, rewind or share
the parent's live session file. The current delegation call is excluded from the
snapshot; completed historical tool calls and results retain their native roles.

## Selecting context

Use `fork_turns` in `delegate_subagent`:

- `"all"`: the captured effective model context, not every raw historical entry.
- `"3"` (or another positive integer string): recent user-message turns, retaining
  a current compaction summary when needed. This is not a model-generated summary.
- `"none"`: start with the explicit assignment and repository instructions only;
  even the routing stage does not read parent history.
- `"auto"` or omitted: choose according to the task, model compatibility and budget.

For explicit `all`/N, an excessive budget or incompatible image modality fails
with an actionable error rather than silently truncating requested evidence.
Auto may narrow at complete turn boundaries and reports the effective selection.
Full forks on another model are supported for information transfer, not for
cross-model KV reuse. Provider-specific opaque thinking/signatures are omitted
when switching models. Pending or orphaned tool calls are not replayed and no
successful tool result is fabricated. Mutable extension/approval markers and
parent model settings are not inherited as child authority.

Old `contextMode` calls remain accepted: `isolated` maps to `none`, `selected` to
`context.forkRecentTurns`, and `summary`/`full` to `all`. Conflicting old/new fields
fail. No legacy `summary` call invokes a summarizer. `maxFullChars`,
`maxSelectedChars`, `selectedMessages`, and the old router conversation/summary
limits remain parseable for configuration compatibility but do not bound native
forks. The new native budgets below are the controls to use.

## Lightweight routing

The configured selector is `openai-codex/gpt-5.3-codex-spark`, effort `low`.
It sees bounded explicit task data, up to 16 eligible model descriptors and parent
metadata (model, effort, turn count, estimated size and image presence). It does
not receive raw parent messages or produce a context summary. Its JSON chooses
only model, effort and fork scope. Existing permission checks remain separate.

Explicit model/effort/fork/permission choices skip the redundant selector. When
Spark is not in the authenticated catalogue, returns invalid JSON or fails, the
existing deterministic model rules are used and the fallback is recorded. The
selector never silently changes to the current expensive main model or makes a
second classification call. This is not a claim that Spark is available on every
account; no real account was queried during offline validation.

Defaults:

```json
{
  "router": {
    "enabled": true,
    "model": "openai-codex/gpt-5.3-codex-spark",
    "effort": "low",
    "maxTaskChars": 6000,
    "maxOutputTokens": 512,
    "timeoutMs": 15000
  },
  "context": {
    "forkRecentTurns": 3,
    "maxForkTokens": 128000,
    "maxForkBytes": 8388608,
    "shareCompatibleCache": true
  }
}
```

`maxTaskChars` bounds the task-data section, not the whole catalogue/prompt.
`maxOutputTokens` is a provider request, **not a guaranteed backend hard cap**;
Pi 0.84.1's Codex adapter does not serialize every generic output-limit option.
A bounded wait and abort signal limit selector latency even if a custom provider
ignores cancellation, but cannot undo token usage already incurred remotely.
Native context estimates use conservative UTF-8/size heuristics with an image
allowance, not an exact tokenizer or a billing measurement. A model-window reserve
and the byte cap supplement the token estimate. Keep indispensable task constraints
in `contextNotes`/`expectedOutput`; automatic windowing is not lossless memory.

## Cache grouping is not session or connection sharing

Main requests are observed but not modified. Workers keep independent session IDs,
headers, connection caches and `previous_response_id` state. On supported Responses
paths, only the outgoing `prompt_cache_key` can change:

1. A full, intact fork may reuse the parent key only when the observed model,
   provider/base URL, non-conversation request configuration, and inherited input
   hashes match. This includes system instructions, tools and request-level effort.
2. Otherwise, a root-scoped hash groups compatible sibling requests without using
   the parent's key. Different models, provider aliases, instructions, tools and
   effort get different groups.
3. With `shareCompatibleCache:false`, unsupported APIs, or an absent original key
   (including cache retention disabled), requests retain their independent behavior.

A normal read-only worker often has different tools from the parent. Such a worker
will therefore **not** qualify for parent-prefix sharing merely because its model
matches. A sibling key does not make the first sibling's input warm. Matching is
checked at the extension request hook; later provider transformations and backend
routing can still affect hits. Authentication is never copied into fork metadata;
server-side account/cache isolation still applies.

This implementation does not introduce `configuration_update`, request-effort
pinning, Responses Lite, or undocumented OAuth cache controls. A different effort
may require a different cached prefix. No tool permissions are enlarged to improve
matching. High cache-read ratios are not proof of lower total cost: a large cached
fork can cost more than a short independent task.

## Permissions, privacy and accounting

A trusted `subagent-context` bootstrap adds no tools. It enforces the existing
read-only/workspace-write tool sets and rejects re-delegation, irrespective of
instructions in inherited history. The previous write-scope prompt and conflict
scheduler remain; this is not a new OS-level sandbox. Model choices do not change
the main agent's selected model or effort.

Native seed, system prompt and metadata files are created with exclusive/no-follow
opens and mode `0600` inside the private ignored run directory. Only that job's
files are removed after child close or startup failure. An abrupt parent/OS kill
can leave private ignored artifacts; no claim of guaranteed secure erasure is made.
No raw history is added to the public activity registry or ordinary job snapshot.

Run snapshots retain separate `routerUsage` and worker `usage`. Optional `fork.cache`
reports counts of **grouping decisions** (`parent`, `siblings`, `independent`), not
measured cache hits, and stores no prompt/key/credential content. Inspect actual
worker `usage.cacheRead`, `input`, `output` and main usage for a cost comparison;
reasoning is part of output. Imported historical assistant records are context,
not new output events to charge again in the parent's worker counter.

## Offline validation

With Node 22.19 and Pi 0.84.1 installed globally:

```sh
node --experimental-strip-types --test --test-concurrency=1 \
  --test-skip-pattern='offline smoke: installed pi --list-models' \
  extensions/smart-subagents/test-*.mjs \
  extensions/plan-mode/test-*.mjs scripts/test-cache-prefix*.mjs
```

The one explicitly excluded smoke requires a locally authenticated model catalogue.
Native SessionManager and installed CLI tests use a synthetic local provider, not
model credentials or network generation. They validate context shape, independent
identity, tool boundaries, fork budgets, current-task append, fresh-output counting
and private-file cleanup. They do not measure real backend cache hits, research
quality, or percentage credit savings.
