# `/rewind`

`rewind` is a conversation-only backtrack for Pi. Run `/rewind` with no arguments, choose a user turn (the current branch is shown newest first), and Pi moves the active conversation to that turn's parent. The chosen prompt is restored to the composer so it can be edited and submitted again.

## Semantics

- The current branch is navigated using Pi's tree API; the selected turn and everything after it disappear from the active transcript/context.
- History is append-only. `/rewind` does **not** delete JSONL lines. It appends an opaque `rewind-cursor` custom entry and reopens the same session file, so the old branch remains available through `/tree`.
- The marker contains only `selectedEntryId`, `previousLeafId`, `targetParentId`, and `createdAt`; prompt text is never copied into durable marker data. Custom entries are not sent to the LLM.
- Workspace files are never reverted.
- The selector uses stable, truncated labels plus entry IDs, so duplicate prompt text still selects the correct entry.
- TUI and PI WEB/RPC use the same `ctx.ui.select` and editor APIs. Same-file replacement rebuilds the transcript/context before restoring the selected text in the replacement context. If the marker is still the leaf on a later resume, the extension derives that text from `selectedEntryId`; after a new message is appended, it no longer restores stale text.

`/rewind` refuses to mutate while Pi is streaming, compacting/retrying, or has pending messages. Cancelling the selector is mutation-free. Ephemeral (`--no-session`) runs cannot reopen a file; they still navigate the in-memory context and restore the editor directly. Images and other attachments are not restored automatically: only the textual portion is recovered, so attachments must be manually re-attached before resubmitting.

This extension does not roll back filesystem state; use your normal VCS/workspace tools for that.
