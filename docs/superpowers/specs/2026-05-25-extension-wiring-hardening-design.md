# Extension Wiring Hardening — Design

**Date**: 2026-05-25
**Status**: Draft
**Scope**: Cross-extension wiring fixes. 14 items across kernel, controlplane, dataplane, transport, session, session-mode, tool-catalog, permission, mcp, sub-agent, frontend.*.
**Mode**: Break-change. No flags, no rollback.

---

## 4. Patch Items (abbreviated — full spec inline)

### 4.1 P0 — Single source of truth for turn termination
Move contractBus emit into `session/onTurnEnd`. Delete emits from run-turn.ts.

### 4.2 P1 — Guard hook phase
Add `'guard'` to Enforce enum. Permission registers onToolCall with `enforce: 'guard'`.

### 4.3 P1 — conflictKey receives ToolContext
`conflictKey?: (toolCtx: ToolContext, input: I) => string`

### 4.4 P1 — RPC method-name conflict detection
Kernel composition throws `RpcMethodConflictError` on duplicate method names.

### 4.5 P1 — Move hello onto rpc.resolve
Uniform dispatch through rpc.resolve; no special-cased 'hello'.

### 4.6 P2 — DataPlane opt-in register API
`dataplane.register(rawType, mapper)` capability.

### 4.7 P2 — Decouple session-mode from tui.*
Replace `tui.inline-block` with neutral `session.planWidget` event.

### 4.8 P2 — Catch bus listener errors
EventBus wraps listener dispatch in try/catch + logs.

### 4.9 P2 — session-mode passes full catalog meta
Use real catalog descriptor, not synthetic empty one.

### 4.10 P2 — frontend-lark auto-starts bots
Read ctx.config.lark in kernelReady, start bots.

### 4.11 P3 — Replace botInstanceCounter with UUID

### 4.12 P3 — session.abort defensive lookup
Warn instead of silent try/catch.

### 4.13 P3 — Typed config getter on KernelContext

### 4.14 P3 — Document lifecycle invariant
