---
title: DB Type-Safe Rules
description: Single-source-of-truth type chain inside apps/backend from Drizzle schema.ts to services and Elysia HTTP routes, plus Drizzle migration rules
tags: [conventions, rules, backend, data]
---

# DB Type-Safe Rules

This document governs the internal type chain inside `apps/backend`: `schema.ts → $inferSelect / $inferInsert & drizzle-zod → adapters & services → Elysia HTTP handlers`. Whenever Drizzle tables and service DTOs are authored separately, `tsc` passes while deleted columns linger and newly added columns silently disappear.

`apps/backend/src/infra/db/schema.ts` is the sole truth source for database shape. Data and types flow strictly one way: **from schema down to HTTP**, never backwards.

## Authoritative files

- `apps/backend/src/infra/db/schema.ts` — All 32 `sqliteTable(...)` definitions, `createSelectSchema` codecs, and `boolToInt`
- `apps/backend/src/infra/sqlite/db.ts` — SQLite open (`WAL`, `foreign_keys = ON`) and Drizzle migration runner
- `apps/backend/src/infra/sqlite/db.test.ts` — Schema assertions (expected tables, dropped legacy tables, active-run partial index)
- `apps/backend/drizzle/backend/` — Committed SQL migrations and `meta/_journal.json`
- `scripts/gen-drizzle.sh` — Drizzle migration generator and CI sync check

## Type Chain

```text
apps/backend/src/infra/db/schema.ts
  sqliteTable(...)               ← single source of truth
  createSelectSchema(...)        ← JSON & int-bool codecs live here
  $inferSelect / $inferInsert    ← compiler-derived row types
        │
        ▼
apps/backend/src/features/<x>/domain.ts
  export type FooRow = typeof schema.foo.$inferSelect
  export type FooView = Omit<FooRow, "payload"> & { payload: ParsedPayload }
        │
        ▼
apps/backend/src/features/<x>/{adapter-sqlite,service}.ts
  Return types derived via Pick / Omit; runtime validation via Select/Insert schemas
        │
        ▼
apps/backend/src/features/<x>/http.ts
  Handler return type = service return type → flows into Elysia App → Eden Treaty
```

## Pre-Change Decision Table

| When you need to... | Required pattern | Forbidden |
|---|---|---|
| Add or alter a column | Edit `schema.ts`, run `bash scripts/gen-drizzle.sh`, let `$inferSelect` propagate | Editing a hand-written service `interface` first |
| Read a DB row | Parse via `xxxSelectSchema.parse(row)`; type via `typeof schema.xxx.$inferSelect` | `row as XxxRow`, hand-written `interface XxxRow` |
| Write a DB row | Validate inputs before insert; type via `typeof schema.xxx.$inferInsert` | Unchecked `db.insert().values(raw)` |
| Define a service return type | Derive with `Pick` / `Omit` / intersection from `$inferSelect` | Hand-writing parallel `export interface FooDto` |
| Return JSON from Elysia `http.ts` | Return the service's typed result directly | Ad-hoc object reshaping that breaks type continuity |
| Store JSON in a `text` column | Add a transform codec in `schema.ts` (`createSelectSchema`) | `JSON.parse(row.col) as T` in feature code |
| Store a boolean in an `integer` column | Transform `v !== 0` on read and use `boolToInt(v)` on write | Scattered `!!row.flag` or `? 1 : 0` |
| Add a status enum value | Define one `as const` tuple / `z.enum` and import everywhere | Repeating string literal unions per file |

## Migration Discipline

1. **Generate and commit migrations** with `bash scripts/gen-drizzle.sh`. CI runs the same check to verify `schema.ts` and `apps/backend/drizzle/backend/` match; drift fails CI.
2. **Hand-written SQL migrations must separate statements with Drizzle's exact arrow marker:**
   ```sql
   --> statement-breakpoint
   ```
   Drizzle's `readMigrationFiles` splits statements strictly on `--> statement-breakpoint`. Writing `-- statement-breakpoint` (missing `>`) does **not** split the SQL; `bun:sqlite`'s `prepare()` executes only the first statement and silently drops the rest while still recording the migration hash.
3. **Verify real SQLite objects, not journal counts.** Confirm new tables, columns, and partial indexes against `sqlite_master` / `PRAGMA table_info(...)` and add assertions in `apps/backend/src/infra/sqlite/db.test.ts`.
4. **Dev DB reset policy:** Migrations guarantee the fresh-boot path. If an older local dev database fails to migrate after schema edits, remove `apps/backend/.backend-data/` and restart.

## Known Debt & Audit Boundary

Unlike cross-process contracts (enforced by `scripts/audit-contracts.ts`), **no automated CI gate enforces all DB type-chain rules yet**. Legacy files still contain hand-written `*Row` interfaces, `JSON.parse(...) as T` casts (notably in `agent-run` and `workflow` adapters), and duplicated status unions.

Before closing a backend PR, spot-check your touched files against:

```bash
grep -rn "interface.*Row\b" apps/backend/src/features/
grep -rn 'JSON.parse(.*) as [A-Z]' apps/backend/src/features/
grep -rn ' as [A-Z][a-z]*Row\b' apps/backend/src/features/
grep -rn '!!.*\.enabled\|.*enabled.*? 1 : 0' apps/backend/src/features/
```

Do not add new debt in touched features; when refactoring an adapter, migrate it onto `$inferSelect` and `drizzle-zod` codecs.

## Boundary with E2E Contract Rules

| Layer | Rule page | Truth source |
|---|---|---|
| Inside `apps/backend` (SQLite → service → HTTP) | This page | `apps/backend/src/infra/db/schema.ts` |
| Across processes (`backend` ↔ `web` ↔ `lark-bot`) | [E2E Contract Rules](./e2e-contract-rules.md) | `App` in `apps/backend/src/app.ts` & `@chengchenccc/api-contract` |

## See also

- [Data Model](./data-model.md) — Complete catalog of all 32 tables, indexes, and atomic transactions
- [E2E Contract Rules](./e2e-contract-rules.md) — Cross-process contract rules and CI gates
- [Design Philosophy](./design-philosophy.md) — Single-ontology principles
