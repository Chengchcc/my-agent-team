---
name: worker_delivery
description: >
  Report progress, blockers, and verified results back to your dispatcher,
  hand back out-of-scope tasks, push code branches safely to agent/<runId>,
  and exchange typed artifacts during worker runs.
roles: worker
user_invocable: true
---

# Worker execution & delivery

When dispatched into a task, you execute inside your isolated workspace/worktree and communicate upward through structured product tools so the PA and human can track progress and verify delivery.

## Tools

| Intent | Tool |
|---|---|
| Report progress, request attention, or deliver answer | `report { purpose: "progress" \| "attention" \| "answer", text, verification? }` |
| Return a task that is outside your scope/access | `handback { reason, suggestion? }` |
| Commit & push worktree to `agent/<runId>` | `project_push { project, message, note? }` |
| Upload / download handoff artifacts | `artifact_upload { folder, filename, content, encoding? }`, `artifact_download { url }` |
| Track your own run checklist | `todo_write { items }` |
| Read settled knowledge or referenced history | `wiki_read`, `wiki_query`, `history_recent`, `history_search`, `history_around` |

## Operating discipline

1. **Hand back early instead of guessing.** If the task requires a repository you do not hold, credentials/permissions you lack, or a skill outside your role, call `handback { reason, suggestion? }` immediately so the dispatcher can re-route or request human authorization. Never silently fake output or work around missing access.
2. **Use `report` with the right `purpose`:**
   - `progress`: durable ledger milestone note; does **not** wake the dispatcher. Use for long multi-step work.
   - `attention`: wakes the dispatcher **now** (blocked on ambiguity, missing access, or unexpected risk). State the exact blocker and what decision/input unblocks you.
   - `answer`: delivers your direct answer/result upward.
3. **Attach honest `verification` status.** Always set `verification` on delivery reports:
   - `"passed"` only when you actually ran the relevant tests/checks and observed them pass.
   - `"failed"` when checks failed (quote the failing command and error).
   - `"not_run"` when checks exist but were not executed (explain why).
   - `"not_configured"` when the target has no automated check suite.
4. **Deliver code via `project_push`, never direct push to `main`/`master`.** Once edits are tested and clean, call `project_push { project, message, note? }`. The backend commits your worktree and pushes `agent/<runId>` for independent review and human merge. Do not use `project_push` to save broken partial work.
5. **Hand off large reports/diffs as artifacts.** For audits, benchmark tables, or generated files that downstream steps or reviewers need, call `artifact_upload` and cite the returned `artifacts://<folder>/<filename>` URL in your `report`.
6. **Respect cited references.** If your `<dispatch>` brief includes `wiki:<path>`, `artifacts://...`, or `seq:<n>` references, read them via `wiki_read`, `artifact_download`, or `history_around` before changing code.
