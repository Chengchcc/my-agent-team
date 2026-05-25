# Self-Learning Follow-up Patch v2 — Design

**Date**: 2026-05-25
**Status**: Draft
**Scope**: Corrective patch on top of the five 2026-05-25 self-learning specs.
**Mode**: Break-change. No flags, no rollback chapter, no observation period.

---

## 1. Why

A first-pass implementation of the five specs landed on `master`. A spec↔code audit plus a runtime wiring audit surfaced:

- **3 runtime-breaking bugs** in the spawn-mode bridge.
- **1 dead code path** (`ContradictionResolver` never instantiated).
- **1 structural deviation** from the rewritten auto-retire spec (still 3-stage flag/grace/retire).
- **1 vocabulary drift** in the memory type enum.
- **3 wiring fragilities** (non-null assertion on optional repo, dual sources of truth for `purpose`, envelope-shape inconsistency, sentinel-based per-turn rate limit).

---

## 2. Goals

1. Make `JOB_SPAWNER=spawn` actually work end-to-end.
2. Make `ContradictionResolver` participate in both implicit-extract and explicit `memory.remember` paths.
3. Align runtime with rewritten specs (2-stage retire, spec-defined memory type vocabulary).
4. Remove wiring fragilities.
5. Delete all code for the abandoned flag/grace/retire flow.

---

## 4. Patch Items

### 4.1 P0 — Spawn wiring (P0-a, P0-b, P0-c)
Already done in v1 patch.

### 4.2 P1 — Wire ContradictionResolver (already done in v1)
Was wired in v1. Verify in code.

### 4.3 P1 — mergeCount on exact dup (already done in v1)

### 4.4 P1 — Collapse AutoRetire to 2-stage (already done in v1)

### 4.5 P1 — Rename MemoryType (already done in v1)

### 4.6 P2 — Guard AutoRetirer against missing SkillMetaRepo
File: `src/extensions/evolution/index.ts`
Replace `metaRepo!` with null guard pattern.

### 4.7 P2 — Single source of truth for purpose
File: `src/extensions/infra-services/job-context-factory.ts`
Drop `purpose` from factory opts; use `req.purpose` inside invoke.
Update callers in evolution/index.ts, memory/index.ts.

### 4.8 P2 — Converge envelope handling
File: `src/extensions/evolution/index.ts`
Remove dual-shape coercion; use `env.payload` directly.

### 4.9 P2 — Real per-turn rate limit via turnId
File: `src/extensions/memory/index.ts` — switch from legacy tools array to `tool-catalog.catalog.register(defineTool(...))`.
File: `src/extensions/memory/explicit-write/remember-use-case.ts` — accept turnId, use real per-turn counter.
File: Add `'tool-catalog'` to memory extension's `dependsOn`.

### 4.10 P3 — Drop legacy memory columns (already done in v1)

### 4.11 P3 — Surface worker invoke failures (already done in v1)
