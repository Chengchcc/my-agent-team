# Follow-up Cleanup Plan — 12 PRs

> Post-PR8/PR9/PR-Z/M/D cleanup. Each PR ≤ 200 lines, independently verifiable.

## Execution order

```
F1 & F2 (parallel P0) → F3 → F6 → F4 → F5 → F7 → F8 → F9 → F10
F11 & F12 (separate schedule)
```

---

## F1 — Delete dead TUI entry + debug.ts

**Files**: `bin/my-agent-tui`, `bin/my-agent-tui.ts`, `src/utils/debug.ts`, `src/interface/daemon/main.ts`

- Delete 3 dead files (bin entry + debug module)
- Remove `setDebugMode(true, logPath)` call from daemon/main.ts
- `debugLog`/`debugWarn` already deleted in ed5832b

---

## F2 — .gitignore out/ + rm cached

**Files**: `.gitignore`

- Add `out/` to .gitignore
- `git rm --cached -r out/` to untrack committed lint artifacts

---

## F3 — Delete 3 dead files + submit-turn

**Files**: `inmem-memory-store.ts`, `inmem-checkpointer.ts`, `submit-turn.ts`, `submit-turn.test.ts`

- All confirmed 0 consumers via grep
- Remove from parent barrels

---

## F6 — Fix knip.json config

**Files**: `knip.json`

- Remove stale entries pointing to deleted files
- Add `domain/agent.ts` to ignore (kept for tests/fixtures)
- Add `tests/fixtures/**` ignore

---

## F4 — Clean 14 unused types

**Files**: ~12 files (kernel/index, contracts, ports, extensions)

- Simple deletions of knip-reported unused type exports
- Resolve TraceReader name collision (trace-writer vs trace-checkpointer)

---

## F5 — Uninstall unused deps

**Files**: `package.json`

- Run confirm-usage grep on each of 6 knip-reported deps
- `bun remove` confirmed dead ones

---

## F7 — Restore swallowed errors

**Files**: `lark-bot-adapter.ts`, `file-logger.ts`, `bun-spawn-job-spawner.ts`

- Replace `void x().catch(()=>{})` with real error handlers (logger.warn or stderr)

---

## F8 — Fix type assertions

**Files**: `unix-socket-transport.ts`, `atomic-write.ts`, `memory/index.ts`, `compact-session.ts`

- Replace `as unknown as` / `as any` / `as never` with proper narrowing

---

## F9 — Fix `case undefined` fallthrough

**Files**: `memory/index.ts`, `lark-bot-adapter.ts`
- Clean up switch exhaustiveness patterns

---

## F10 — codec compat + NDJSON test

**Files**: `tests/contracts/history-record-compat.test.ts`
- Add NDJSON boundary test for parseHistoryLine
- Ensure compact metadata round-trips

---

## F11+F12 — Deferred (max-lines split + magic-number audit)
