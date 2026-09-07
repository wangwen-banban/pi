# Research autonomy and decision prompts

The default is to finish the requested task within its scope and permissions,
not to seek approval at every research phase. Normal research should need zero
routine decision prompts. This is prompt guidance, not an automatic approval
mechanism or a hard quota on legitimate questions.

## What changed

`AGENTS.md` and the registered Plan Mode tool descriptions/guidelines now share
an evidence-first boundary: interrupt only for a material decision that cannot
be resolved from the available instructions and reasonable investigation, and
has no safe, reversible default within the authorized scope. Explicit ask-first
instructions and mandatory safety/permission approvals take precedence.

The runtime guidance matters even when a research session runs outside this
repository. `ask_user` has its own guidelines rather than relying solely on the
`enter_plan_mode` instructions. A decision question can be asked outside Plan
Mode; it does not require an enter/ask/exit approval sequence. Preparing a
research plan as a deliverable does not itself require Plan Mode.

Tool results no longer recommend immediately asking again after cancellation.
Cancellation and silence are not consent. The agent should continue independent
authorized work, or report what remains blocked. A necessary approval stays
necessary; a user rejection is not an instruction to bypass the gate.

## Examples

| Situation | Expected behavior |
| --- | --- |
| Choose search terms, which papers to read first, or report layout | Choose a reasonable default and continue. |
| Compare two hypotheses or reversible methods | Gather evidence and compare them; do not require an early preference. |
| Run a bounded local check or fix a recoverable test failure | Continue within the requested scope and resource limits. |
| Finish one research phase and begin the next already-requested phase | Give a brief progress update, not a "shall I continue?" question. |
| Change the main research objective or commit to a breaking architecture migration | Ask when the choice is material, unresolved, and lacks a safe default. |
| Spend beyond an agreed budget, publish externally, disclose private data, or make destructive/production changes | Obtain the required permission; autonomy is not blanket consent. |
| User explicitly requests a plan for approval before implementation | Preserve the Plan Mode approval gate. |
| User cancels a dialog | Do not immediately repeat it; do only independent authorized work. |

When asking is necessary, explain what is blocked, recommend a path, and batch
related decisions when practical. Do not ask the same decision in both a
selection dialog and an approval dialog. Research budgets left unspecified do
not authorize expensive or unbounded experiments.

## Unchanged boundaries

No changes to tool schemas beyond descriptive text, available choices, approval
callbacks, branch markers, read-only checks, subagent permission enforcement,
headless fail-closed behavior, model settings, or the append-only context
snapshot mechanism. There is no cooldown, model-based question classifier, or
auto-approval timeout. The user can still explicitly enable or disable `/plan`.

## Validation and use

With the repository's Pi 0.84.1 runtime installed globally:

```sh
node --experimental-strip-types --test extensions/plan-mode/test-*.mjs scripts/test-cache-prefix*.mjs
```

`test-autonomy.mjs` checks the real registered prompts and preserves necessary
choices, cancellation semantics, write blocking, delegated read-only work, and
headless safety. Existing Plan Mode/UI and cache regressions must also pass.
These tests do not measure a real model's question frequency or research speed.

After pulling the change, finish active background work before `/reload` or
restart Pi. Existing history can still contain the old instructions; a new
session is the cleanest behavior comparison. User-local skills, project prompts,
and external extensions can add their own clarification requirements and are
not changed by this repository patch.
