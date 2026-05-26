# Project-wide Bug Audit & Fix — Design

**Date**: 2026-05-26
**Status**: Draft
**Scope**: 20 bug fixes across memory, kernel, event-bus, contracts, session, permission, mcp, lark, identity, sqlite, jobs, logging.
**Mode**: Break-change. Hotfix wave (4.1-4.4) first, then remaining waves.

## Hotfix Wave (P0)

### 4.1 — Fix supersede empty-newId data rot
supersede(oldId, '') writes superseded_by='' → rows vanish. Fix: validate newId non-empty and exists; migration cleans existing bad rows.

### 4.2 — Fix P2P sessions all sharing 'main'
Lark P2P hardcodes sessionId='main'. Replace with `lark-p2p-${anchor.userId}`.

### 4.3 — Permission gate must cover all dangerous tools
Only 'write' triggered gate. Move to config-based dangerousTools list with defaults ['bash','bash_run','exec','edit','write','task'].

### 4.4 — Identity bootstrap draft path lookup
`deps.store['filePath'] ?? ''` writes to ''. Add public `getDraftPath()` method.

## Wave-1 (P1) — Contracts + Infra

### 4.5-4.8 — TurnCompletedV1 contract fixes
Drop runId, populate activatedSkills, null vs 0 for usage, contractBus.emit returns Promise<void>.

### 4.9-4.16 — Infra correctness
storeEmbedding await, arbitration catch, hook mode doc, MCP onclose leak, permission sessionId fallback, lark createSession throw, file-logger fail-safe, spawn worker exit guard.

## Wave-2 (P2) — Defensive
### 4.17-4.20
supersede validation, memory draft id placeholder, eventBus redaction, parentTurnId collision.
