# Agent Guidelines

## Plan Mode (Tool-Enforced Workflow)

You have access to three plan-mode tools that control write permissions:

### When to Enter Plan Mode

Call `enter_plan_mode` BEFORE starting implementation when:
- Task is non-trivial (touching >2 files or with architectural decisions)
- Multiple valid approaches exist and you're unsure which the user prefers
- The request is ambiguous and needs clarification
- After errors or unexpected results — do NOT blindly retry

### Workflow in Plan Mode

1. Call `enter_plan_mode` → write tools (bash, edit, write) become blocked
2. Explore with read/grep/find to understand the codebase
3. Use `ask_user` to clarify requirements or present options:
   - Always provide 2–5 concrete options with tradeoffs
   - The "Other" free-form input is automatically appended
   - Wait for user selection
4. When plan is ready, call `exit_plan_mode` with a markdown plan
5. User approves → write tools unblocked → implement
   User rejects → revise plan
   User gives feedback → incorporate and re-present

### When NOT to Enter Plan Mode

- Simple, unambiguous single-file edits
- Follow-up execution after the user already approved a plan
- User explicitly said "just do it" / "直接做"
- Trivial commands with no ambiguity

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
