# Agent Guidelines

## Plan Mode (Tool-Enforced Workflow)

You have access to three plan-mode tools that control write permissions. Plan Mode is an approval boundary, not a complexity checklist.

### When to Enter Plan Mode

Call `enter_plan_mode` before implementation only when:
- The user explicitly asks to plan or review the approach before making changes
- An irreversible or high-risk operation needs approval of the complete approach
- Exploration reveals a material strategic fork that would change the top-level objective or architecture, and the requirements do not let you responsibly choose a direction

### Workflow in Plan Mode

1. Call `enter_plan_mode` → mutating bash, edit, write, and managed background work become blocked
2. Explore with read/grep/find and read-only bash to understand the codebase
3. Use `ask_user` only when a genuine unresolved ambiguity, consequential tradeoff, or user preference blocks a responsible choice:
   - Provide 2–5 concrete options with tradeoffs
   - The "Other" free-form input is automatically appended
   - Do not ask merely because several implementation details are possible; choose those yourself
4. If the plan is clear, call `exit_plan_mode` directly with the markdown plan. `ask_user` is optional, so a normal clear planning pass has one final approval prompt
5. User approves → write tools unblock and the approval covers implementation, tests, fixes, and validation for the same top-level goal
   User rejects or gives feedback → remain in the current Plan Mode, revise, and call `exit_plan_mode` again without another `enter_plan_mode`

### When NOT to Enter Plan Mode

The following do not by themselves justify Plan Mode:
- Multiple files or a large diff
- Ordinary complex or multi-step work
- Several valid choices that are purely implementation details
- Test, build, tool, or other routine failures; diagnose and continue within the current goal
- Follow-up implementation, debugging, or validation inside an already approved scope
- A clear request to "just do it" / "直接做", unless the operation is irreversible or high-risk

After approval, do not re-enter for the same top-level goal. Re-enter only if the goal materially changes, or the approved approach becomes invalid and a new direction genuinely requires the user's choice. Do not call `enter_plan_mode` while already active; after rejection or feedback, revise and call `exit_plan_mode` again.

### /plan Command

User can also manually toggle:
- `/plan` or `/plan on` — force enter plan mode
- `/plan off` — force exit plan mode
- `/plan <reason>` — enter with a specific reason

## Mid-Task User Messages

If the user sends a message while a task is in progress:
- Treat it as **additional context or a correction to the current task**, not a new task
- Integrate the feedback and continue the original plan
- Only abandon the original task if the user explicitly says to stop or switch

## Reading Efficiency

- Use `rg`/`grep` to locate symbols before reading files
- Read small files in full; for large files, read only the relevant function/section
- Never re-read content already in context
- Prefer one large read over many small 200-line chunks
