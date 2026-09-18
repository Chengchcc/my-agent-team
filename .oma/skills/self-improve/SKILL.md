---
name: self-improve
description: >
  Dogfood RSI loop: oma improves oma. Read failure signals, propose ONE
  bounded edit within .oma/rsi/scope.json, validate via CI, record lineage.
  Never merges its own PRs.
user_invocable: true
---

# Self-Improve (dogfood RSI)

One Run = one candidate. Phases run in order; never merge phases.

## 1. Observe (read-only)

- CI failures (`gh run list` has no `--status` flag — filter the JSON):
  ```sh
  gh run list --branch master --limit 20 --json databaseId,conclusion \
    --jq '.[] | select(.conclusion=="failure") | .databaseId'
  gh run view <id> --log-failed
  ```
- Past candidates: read `.oma/rsi/lineage.jsonl` — a cause already tried and
  red needs a DIFFERENT edit, not a retry.
- Pick ONE cause. Nothing red and no clear win? End the Run with "no
  candidate". A no-op round is a valid outcome.

## 2. Propose (one bounded edit)

- Read `.oma/rsi/scope.json`. The edit must match an `allow` glob and no
  `deny` glob — deny wins.
- Smallest possible diff. One PR = one edit.
- `git checkout -b rsi/<short-slug>` from latest master.

## 3. Evaluate

- Run the guard first: `bun scripts/rsi-guard.ts origin/master...HEAD` — a
  red guard means wrong scope; start the proposal over.
- Scoped local smoke only (`bun test <touched package>`); never the full
  suite on this box.
- `git push -u origin rsi/<slug>`, `gh pr create --label rsi --fill`, then
  `gh run watch` the CI run to completion.

## 4. Record, then stop

- Append one JSON line to `.oma/rsi/lineage.jsonl` and commit it to the PR
  branch:
  `{"ts":"<ISO>","branch":"rsi/<slug>","base":"<sha>","cause":"<one line>","files":["..."],"guard":"pass","ci":<run id>,"pr":<n>,"merged":false}`
- Red CI: leave the branch alive (branches are the archive — never delete
  failed branches), record, stop.
- Green CI: record, stop. A human merges. Do NOT merge, rebase, or
  force-push.

## Hard rules

- Never edit: `.oma/rsi/scope.json`, `scripts/`, `.github/`, `**/*.test.ts`,
  any `package.json`, `bun.lock` — these are the gate, and the gate checks
  them again in CI.
- Never weaken a test, coverage floor, or CI step — not even "temporarily".
- Score = CI verdict. Logs of tests you did not run are not a score.
- An idea that needs a deny path: write `.oma/rsi/proposals/<slug>.md` for
  the human instead of editing.
