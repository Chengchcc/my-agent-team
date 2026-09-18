# Blocked: the RSI scaffold is not on master yet

**Status:** the self-improve loop ran one Observe-only round on 2026-09-18 and
ended with **no candidate**. No branch, no PR, nothing pushed.

## Blocker (dominant)

The entire loop scaffold exists only in the unpushed local commit
`fe2dd953` (`chore(repo): scaffold dogfood RSI self-improve loop`), which is
1 commit ahead of `origin/master` (`8d3fab99`):

```
git log --all --oneline --source -- .oma/rsi/scope.json
fe2dd953  refs/heads/master  chore(repo): scaffold dogfood RSI self-improve loop
```

Neither the skill, nor `scope.json`, nor `scripts/rsi-guard.ts`, nor the
`rsi-gate` CI job is present in any remote ref (verified with
`git cat-file -e origin/master:<path>` and `git show origin/master:.github/workflows/ci.yml`).

Consequences — there is no valid branch base, so every candidate is invalid
by construction:

| base | why it fails |
|---|---|
| `origin/master` | allow-listed targets `.oma/rsi/**`, `.oma/skills/**` do not exist there; `scripts/rsi-guard.ts` is absent so the guard cannot run; CI has no `rsi-gate` job. Editing would author the scaffold files upstream and collide with the human's scaffold PR. |
| local `HEAD` (`fe2dd953`) | `bun scripts/rsi-guard.ts origin/master...HEAD` is **red with 4 out-of-scope paths** (`.github/workflows/ci.yml`, `.gitignore`, `.oma/rsi/scope.json`, `scripts/rsi-guard.ts`) — the gate file itself is self-denied, so an rsi-labeled PR can never carry it. Reproduced, not inferred. |

The skill's Evaluate phase ("run the guard first", "CI is the score") is
therefore unrunnable, and the skill's own rule is that a red guard means
start the proposal over — with no base that yields a green guard.

**Fix:** land `fe2dd953` on master as a normal (non-`rsi`) human-reviewed PR.
It touches `scripts/`, `.github/`, and `scope.json`, all of which the scope
list deliberately denies to the loop. The loop resumes on the next Run.

## Bug to fix in the same human PR (verified)

Phase 1's Observe command cannot execute on the installed `gh`:

```
$ gh run list --branch master --status failure --limit 5
unknown flag: --status
```

`gh run list` has no `--status` flag, so the loop's first command hard-fails
every Run. Verified working replacement (returns run IDs, empty when master
is green):

```
gh run list --branch master --limit 20 \
  --json databaseId,conclusion \
  --jq '.[] | select(.conclusion=="failure") | .databaseId'
```

`gh run view <id> --log-failed` in the same step is correct as written
(verified against `gh run view --help`).

## Secondary observation (not a blocker)

Phase 2 says "`git checkout -b rsi/<short-slug>` from latest master" without
naming the start point. `git checkout -b` with no start point means local
`HEAD`, and any unpushed local commit is then inside `origin/master...HEAD`
and trips the guard on unrelated files — exactly the failure tabulated
above. Suggested wording: `git fetch origin master && git checkout -b
rsi/<slug> origin/master`.
