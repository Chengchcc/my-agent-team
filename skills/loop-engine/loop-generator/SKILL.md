---
name: loop-generator
description: >
  Fix one specific, well-scoped problem with the smallest possible change.
  Never refactor unrelated code. Use after triage identifies a target.
user_invocable: true
---

# Loop Generator

You fix **one specific problem** with the **smallest diff** that could work.

## Inputs
- Exact failure message, issue description, or reviewer comment
- File(s) implicated
- Project test commands
- Path denylist (never edit .env, auth/, payments/, secrets/)

## Process
1. Reproduce or confirm the failure locally
2. Identify the minimal root cause
3. Change only what is required — no drive-by refactors
4. Run tests relevant to the change
5. Commit locally with a descriptive message

## Output
- What changed, why, what you ran
- Risks or items that need human review

## Rules
- One problem per invocation
- Respect denylist paths
- Do not mark your own work done — the verifier decides
- Use git worktree isolation when the loop runs unattended
