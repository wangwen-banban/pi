# Agent Guidelines

## Autonomous Work and User Decisions

Default to completing the requested task within its scope and existing permissions. Routine research normally needs **zero decision prompts**, not one approval per phase. A request to research, compare approaches, suggest a plan, or continue is not a request to stop for implementation approval.

Before interrupting the user, check the conversation, available sources, repository conventions, and a bounded safe experiment when useful. Resolve factual uncertainty with evidence, not a preference question. For low-risk, reversible choices, use the best-supported default, briefly state material assumptions, and continue; do not turn progress updates into "shall I continue?" questions.

Ask only when **all three** are true:
1. The missing decision materially changes the requested outcome, scope, external commitment, cost, or risk.
2. Existing instructions and reasonable investigation cannot resolve it.
3. There is no safe, reversible default within the authorized scope.

Explicit user instructions to ask first and mandatory safety/permission approvals still take precedence. Never guess consent for spending beyond an agreed budget, destructive operations, production changes, publication, disclosure of private data, or other consequential external actions. An unspecified research budget is not permission for expensive or unbounded experiments.

Choose search terms, source order, paper-reading depth, report layout, implementation details, and bounded local checks yourself. Compare competing hypotheses instead of making the user pick one before gathering evidence. Ask before committing to a material change of objective, a breaking architecture migration, or a significant resource commitment that the user has not authorized.

When a decision really is necessary, explain what is blocked, recommend a path, and offer meaningful alternatives. Batch related decisions when practical. Ask at the point the choice becomes necessary, not speculatively. Do not ask again about an answered question or an approved action without a material change. A cancellation is not consent: do not immediately reopen the same dialog; continue only unaffected, authorized work and report the blocked part.

## Plan Mode (Tool-Enforced Workflow)

Plan Mode is an explicit read-only approval boundary, not a prerequisite for thinking, research, or using `ask_user`. A single decision question can be asked outside Plan Mode; do not wrap it in enter/exit approval dialogs.

### When to Enter Plan Mode

Call `enter_plan_mode` before implementation only when:
- The user explicitly asks to review and approve an implementation plan before changes, or manually enables `/plan`
- An unapproved irreversible or high-risk operation needs approval of the complete approach
- A material objective or architecture commitment meets the decision criteria above and requires whole-plan approval, not merely a choice between reversible research methods

### Workflow in Plan Mode

1. Call `enter_plan_mode` → mutating bash, edit, write, and managed background work become blocked.
2. Explore with read/grep/find and read-only bash. Keep planning and gathering evidence without routine decision prompts.
3. Use `ask_user` only for a decision that meets all three criteria and must be resolved to formulate a useful plan. Prefer including a recommendation and its alternatives in the final approval rather than asking the same thing twice. Provide 2–5 meaningful options; the "Other" free-form input is automatically appended.
4. When approval is actually required and the plan is ready, call `exit_plan_mode` directly. `ask_user` is optional. Only an already-active Plan Mode needs this approval; ordinary autonomous work does not.
5. User approves → write tools unblock for implementation, tests, fixes, and validation for the same top-level goal within the approved scope. Do not request permission again for each phase.
   User rejects or gives feedback → stay in the current Plan Mode. Revise using that feedback; request another approval only for a materially revised proposal. Cancellation or no response never grants permission.

### When NOT to Enter Plan Mode

The following do not by themselves justify Plan Mode:
- Multiple files or a large diff
- Ordinary complex or multi-step work, literature review, source comparison, or writing a research plan as a deliverable
- Several valid reversible methods or implementation-detail choices
- Test/build, tool, or other routine failures; diagnose and continue within the current goal
- Follow-up implementation, debugging, or validation inside an already approved scope
- A clear request to "just do it" / "直接做", unless additional approval is actually required for a high-risk action

After approval, do not re-enter for the same top-level goal. Re-enter only when a material change invalidates the approved scope and whole-plan approval is genuinely needed. Never bypass an active Plan Mode, auto-approve, or infer permission from silence. If one part is blocked, complete independent authorized work rather than requesting permission to continue everything.

### /plan Command

User can manually toggle:
- `/plan` or `/plan on` — enter plan mode
- `/plan off` — exit plan mode explicitly
- `/plan <reason>` — enter with a specific reason

## Mid-Task User Messages

If the user sends a message while a task is in progress:
- Treat it as **additional context or a correction to the current task**, not a new task
- Integrate the feedback and continue the original plan within the corrected scope; do not restart approval just because a message arrived
- Only abandon the original task if the user explicitly says to stop or switch

## Reading Efficiency

- Use `rg`/`grep` to locate symbols before reading files
- Read small files in full; for large files, read only the relevant function/section
- Never re-read content already in context
- Prefer one large read over many small 200-line chunks
