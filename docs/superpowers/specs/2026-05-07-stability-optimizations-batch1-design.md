# Stability Optimizations — Batch 1 Design Spec

**Date**: 2026-05-07
**Scope**: Compaction cascade protection, sub-agent cwd isolation, MCP reconnect backoff
**Status**: Approved

---

## 1. Compaction Cascade Protection

### Problem

When a large user input pushes token usage past 75%, Tier 2 (LLM summarization) fires. The summary itself consumes tokens, so post-compaction usage may still exceed the Tier 2 threshold, triggering another LLM call. This cycle wastes API calls and delays the user without meaningfully reducing context.

### Design

Add cascade detection state to `TieredCompactionManager`:

- `compactionHistory: Array<{beforeTokens: number, afterTokens: number, tier: CompactionTier}>` — rolling window of last 3 compactions
- On each compaction: compute `reductionRatio = (beforeTokens - afterTokens) / beforeTokens`
- If the last 2 consecutive compactions both have `reductionRatio < 0.05`: skip directly to Tier 4 (Collapse)
- `resetCompactionState()` called at conversation start / user clear

### Files Changed

| File | Change |
|------|--------|
| `src/agent/compaction/compaction-manager.ts` | Add cascade detection fields and logic (~40 lines) |
| `tests/compaction/compaction-cascade.test.ts` | New test file — verify cascade escalation |

### Edge Cases

- Less than 2 compactions in history: no cascade check, normal flow
- Tier 4 already applied: no-op, don't double-collapse
- Reduction ratio exactly 5%: treated as insufficient (strict `< 0.05`)
- State reset on ContextManager.clear() and new AgentLoop start

### Architecture Constitution Compliance

- No new public API — internal state change only
- No new dependencies
- File stays under 400 lines
- No `as any`, no `console.log`

---

## 2. Sub-Agent cwd Isolation

### Problem

The `SubAgentTool` gives child agents their own ToolRegistry and ContextManager, but bash tool execution uses the parent process's cwd. A sub-agent instructed to run file operations could accidentally (or maliciously) affect files outside its worktree.

### Design

Wrap the bash tool registered in the sub-agent's ToolRegistry to force `cwd`:

1. In `SubAgentTool.execute()`, determine the isolation directory:
   - If worktree is configured and active: use worktree path
   - Otherwise: create a temp directory via `fs.mkdtempSync()`
2. Create `wrapBashTool(originalTool, isolatedCwd)` that returns a tool with the same interface but forces `params.cwd = isolatedCwd` before calling the original
3. Replace the bash tool in the sub-agent's registry with the wrapped version
4. On sub-agent completion (in `finally` block): if a temp dir was created, clean it up via `fs.rmSync(dir, {recursive: true, force: true})`

### Files Changed

| File | Change |
|------|--------|
| `src/agent/sub-agent-tool.ts` | Add bash tool wrapping and temp dir lifecycle (~35 lines) |
| `tests/sub-agent-isolation.test.ts` | New test — verify bash cwd is forced |

### Edge Cases

- `read_only` profile: skip wrapping (no bash tool registered)
- Worktree path doesn't exist: fall back to temp dir
- Cleanup failure: catch and `debugLog`, don't throw (sub-agent result already returned)
- Concurrent sub-agents: each gets its own temp dir (via unique suffix)

### Architecture Constitution Compliance

- No new `ToolDispatcher` branch — uses existing tool execution
- No changes to bash tool itself — wrapper pattern preserves original behavior
- Sub-agent tool already creates filtered registries; this extends that pattern

---

## 3. MCP Reconnect Backoff

### Problem

The current reconnect logic has no maximum retry limit. A permanently dead MCP server causes infinite reconnect attempts. There's no jitter, so reconnection storms can occur. Users are not notified when a server exhausts retries.

### Design

Enhance `McpManager` reconnection logic:

1. **Max retries**: `MAX_RECONNECT_ATTEMPTS = 5` (configurable via `McpManagerOptions`)
2. **Exponential backoff with jitter**: `delay = baseDelay * 2^attempt * (0.75 + Math.random() * 0.5)` → range 1s–16s with ±25% jitter
3. **New status**: `exhausted` — entered when max retries reached
4. **Notification**: call `onStatusChange(serverName, {status: 'exhausted', message})` callback
5. **Resource cleanup**: on exhausted, clear transport listeners and remove client reference
6. **Reset on success**: counter reset to 0 on successful reconnect

### Files Changed

| File | Change |
|------|--------|
| `src/mcp/types.ts` | Add `'exhausted'` to `McpServerStatus`, add `maxReconnectAttempts` to options (~10 lines) |
| `src/mcp/manager.ts` | Add retry counter map, jitter, exhausted state, callback (~45 lines) |
| `tests/mcp/reconnect-backoff.test.ts` | New test — verify max retries and jitter range |

### Edge Cases

- Manual disconnect: `disconnecting` flag already prevents reconnect — no change needed
- Successful reconnect before exhaust: counter resets to 0
- Server config with `autoStart: false`: no reconnect attempts
- Callback not provided: skip notification, just debugLog
- Network transports vs stdio: backoff applies to both

### Architecture Constitution Compliance

- No new dispatch branches
- No new dependencies (jitter is plain Math.random)
- Callback pattern already exists in McpManager (onReady)

---

## Testing Strategy

| Item | Unit Test | Integration Test |
|------|-----------|-----------------|
| Cascade protection | Verify cascade detection math, verify state reset | N/A (pure logic) |
| cwd isolation | Verify wrapper forces cwd, verify cleanup | Verify sub-agent bash runs in isolated dir |
| MCP backoff | Verify jitter range, verify counter exhaustion | Verify transport.onclose triggers backoff sequence |

---

## Rollout Order

All three changes are independent. Implement in any order.

1. Compaction cascade protection
2. Sub-agent cwd isolation
3. MCP reconnect backoff
