---
title: E2E Contract Rules
description: Single-source-of-truth rules for cross-process contracts (HTTP, AHP, React Query, env vars, shared schemas) and automated CI audit gates
tags: [conventions, rules, contracts]
---

# E2E Contract Rules

This document enforces [Design Philosophy](./design-philosophy.md) ("unify ontology; never duplicate semantics") across process boundaries (`backend`, `web`, `lark-bot`, `oh-my-agent`). Whenever a contract is written twice across processes, TypeScript stops seeing drift and `as` casts cement silent bugs. Every cross-process boundary has **one** authoritative definition; all consumers derive from it.

## Authoritative files

- `scripts/audit-contracts.ts` — Automated CI gate (`bun run audit:contracts`)
- `scripts/audit-workspace.ts` — Monorepo workspace, `tsconfig.json` references, and `AGENTS.md` dependency graph gate (`bun run audit:workspace`)
- `scripts/audit-ui.ts` — Web UI conventions and zero-CJK-outside-locales gate (`bun run audit:ui`)
- `scripts/audit-docs.ts` — Active-zone link, frontmatter, vocabulary, and code-path gate (`bun run audit:docs`)
- `apps/backend/src/app.ts` — Exports Elysia `App` type (HTTP single source of truth)
- `packages/api-contract/src/index.ts` — Shared cross-process Zod schemas (`lark.ts`, `sse.ts`, `artifact.ts`, `workflow.ts`)
- `packages/ahp-client/src/index.ts` — WebSocket transport and AHP URI helpers
- `packages/config/src/env.ts` — Shared `envSchema` and `parseEnv()`
- `apps/web/src/lib/client.ts` — Eden Treaty `client` and `createServerClient()`

## Pre-Change Decision Table

| When you need to... | Source of truth | Forbidden |
|---|---|---|
| Read a new backend field in Web | Update the backend service/route return type so it flows through `App` | Hand-writing or extending an `interface` in `apps/web` |
| Call a backend HTTP endpoint | `client.api.*` via Eden Treaty (`apps/web/src/lib/client.ts`) | `apiFetch<T>`, raw `fetch` with `as` casts |
| Subscribe to live updates | AHP over `/ws/ahp` (`POST /api/ahp/ws-ticket` → `@microsoft/agent-host-protocol` types) | `new EventSource`, ad-hoc WebSockets, custom SSE event maps |
| Add a React Query hook | `queryOptions(params)` inside `apps/web/src/features/<x>/queries.ts` | Inline `queryFn:` inside `apps/web/src/app` or `apps/web/src/components` |
| Read an environment variable | `packages/config/src/env.ts` (`envSchema` + `parseEnv()`) | Direct `process.env.*` reads outside whitelisted bridges |
| Pass structured data across processes | Export a shared Zod schema (e.g. `@chengchenccc/api-contract`) and parse on both ends | Parallel interfaces + `as { ... }` casts |
| Add a status or enum value | Mutate the shared `as const` tuple or `z.enum(...)` | Copy-pasting union literals in another package |
| Read/write a DB JSON column | Bidirectional `drizzle-zod` transform in `schema.ts` | `JSON.parse(row.x) as T` in feature code |
| Enforce UI language or dialogs in Web | English source strings in `t(...)` + `lib/locales/`; `useConfirm()` + `@/components/ui/*` | Hardcoded CJK outside `lib/locales/`, `window.confirm`, `window.alert` |

## Contract Truth Map

| Contract | Authoritative source | How consumers read it |
|---|---|---|
| HTTP routes & payloads | `App` exported by `apps/backend/src/app.ts` | Eden Treaty (`treaty<App>`) in `apps/web/src/lib/client.ts` |
| Live conversation/run state | `@microsoft/agent-host-protocol` + `_meta` extensions (`apps/backend/src/features/ahp/state-source.ts`) | `@chengchenccc/ahp-client` + upstream `chatReducer` |
| React Query keys & fetchers | `apps/web/src/features/*/queries.ts` | Components invoke exported hooks only |
| Environment variables | `packages/config/src/env.ts` (`envSchema`) | `parseEnv()` |
| Cross-process DTOs (Lark, todos, budget gates) | `packages/api-contract/src/index.ts` | Imported and `.parse()`d at boundaries |
| Oma ACP extension events | `apps/oh-my-agent/src/protocol/mapping.ts` + `apps/backend/src/features/agent-run/acp/event-mapping.ts` | Parity locked by `apps/oh-my-agent/src/protocol/mapping.test.ts` |
| Cross-package imports | Package barrels (`packages/<name>/src/index.ts`) | ESLint `consistent-type-imports` + no deep imports |

## Automated CI Gates (`bun run audit`)

All four audit scripts run fast in CI and locally via `bun run audit`:

### 1. `scripts/audit-contracts.ts`
- **Zero-tolerance rules:**
  - `new EventSource` anywhere in `apps/web/src` (0 allowed; live updates use AHP).
  - `apiFetch<` or `as AgentRow` in `apps/web/src`.
  - Inline `queryFn:` in `apps/web/src/app` or `apps/web/src/components` (note: `queryKey:` is allowed for `invalidateQueries`).
  - `apps/backend/src/bootstrap/features.ts` must normalize the product-tools SSE URL via `sseUrlEndpoint(config.productToolsMcpUrl)` and pass `bearerTokenEnv: "PRODUCT_TOOLS_RUN_TOKEN"`.
  - One-way runtime boundary: `apps/oh-my-agent/src/core/runtime/` must never import `modes/`, `core/gateway/`, or `core/update/`.
- **Tracked debt baselines (must not grow):**
  - Bare `as {` / `as Record<` casts in `apps/lark-bot/src` (allowlisted only in `ingest.ts`, `bootstrap.ts`, `bindings-sqlite.ts`).
  - Direct `process.env.` reads outside `ENV_BRIDGE` (6 backend bridge files; **0** allowed in `apps/web/src` and `apps/lark-bot/src`).

### 2. `scripts/audit-workspace.ts`
- `W1`: Root `package.json` `workspaces` globs must cover every `apps/*` and `packages/*` directory containing a `package.json`, with no empty or redundant globs.
- `W2`: Root `tsconfig.json` project `references` must match TypeScript projects on disk bidirectionally.
- `W3`: `AGENTS.md`'s package dependency graph must name every workspace member.

### 3. `scripts/audit-ui.ts`
- Zero-tolerance for `window.confirm(` and `window.alert(` in `apps/web/src`.
- Zero-tolerance for CJK characters (`[\u4e00-\u9fff]`) anywhere in `apps/web/src` outside `apps/web/src/lib/locales/` (ADR 0079).

### 4. `scripts/audit-docs.ts`
- Verifies `CLAUDE.md` symlinks to `AGENTS.md`, `AGENTS.md` table/plugin counts and `Important Files` paths, relative links across `docs/architecture/`, `docs/guides/`, `docs/adr/`, and app docs, YAML frontmatter (`title` + `description`) on every `docs/architecture/**/*.md`, repo-rooted code paths (`apps/...`, `packages/...`), forbidden deleted-concept phrases, balanced code fences, and zero orphan pages.

## Checklist When Adding a New Contract

1. Which existing domain entity owns this contract?
2. Which package holds the single source of truth so all consumers derive types rather than copying them?
3. If someone modifies one side six months from now, will `bun run typecheck` or `bun run audit` fail loudly? If not, the contract is not yet converged.

## See also

- [Design Philosophy](./design-philosophy.md) — Core ontology and boundary principles
- [DB Type-Safe Rules](./db-typesafe-rules.md) — Single-source rules inside `apps/backend` (SQLite → HTTP)
- [AHP Surface Contract](./ahp-surface-contract.md) — WebSocket live-state protocol and `_meta` extensions
