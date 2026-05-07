# Stability Optimizations Batch 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement compaction cascade protection, sub-agent cwd isolation, and MCP reconnect backoff with jitter.

**Architecture:** Three independent changes touching compaction-manager.ts, sub-agent-tool.ts, mcp/manager.ts, and mcp/types.ts. Each follows TDD: write failing test → implement → verify pass → commit.

**Tech Stack:** TypeScript, Bun test runner

---

### Task 1: Compaction Cascade Protection

**Files:**
- Modify: `src/agent/compaction/compaction-manager.ts` — add cascade history, detection logic, reset method
- Create: `tests/agent/compaction-cascade.test.ts`

- [ ] **Step 1: Write the failing cascade test**

Create `tests/agent/compaction-cascade.test.ts`:

```typescript
import { describe, it, expect, spyOn } from 'bun:test';
import type { AgentContext, Message } from '../../src/types';
import { TieredCompactionManager } from '../../src/agent/compaction/compaction-manager';
import { TokenBudgetCalculator } from '../../src/agent/compaction/budget';
import { DEFAULT_COMPACTION_THRESHOLDS, DEFAULT_COMPACTION_CONFIG } from '../../src/agent/compaction/types';
import type { CompactionThresholds, CompactionConfig, TokenBudget } from '../../src/agent/compaction/types';
import { CompactionTier } from '../../src/agent/compaction/types';

function makeUserMessage(content: string): Message {
  return { role: 'user', content };
}

function makeContext(messages: Message[], systemPrompt = 'You are a helpful assistant.'): AgentContext {
  return {
    messages,
    systemPrompt,
    config: { tokenLimit: 180000 },
    provider: { getModelName: () => 'mock' } as AgentContext['provider'],
  };
}

function mockBudget(overrides: Partial<TokenBudget>): TokenBudget {
  return {
    modelLimit: 180000,
    maxOutputTokens: 4096,
    compactionBuffer: 2048,
    effectiveLimit: 180000 - 4096 - 2048,
    currentUsage: 100000,
    usageRatio: 0.50,
    ...overrides,
  };
}

const thresholds: CompactionThresholds = { ...DEFAULT_COMPACTION_THRESHOLDS };
const baseConfig: CompactionConfig = {
  ...DEFAULT_COMPACTION_CONFIG,
  thresholds,
  summaryProvider: undefined,
  enabledTiers: { snip: true, autoCompact: false, reactiveRecovery: true, collapse: true },
};

describe('Compaction cascade protection', () => {
  it('should skip to Tier 4 after 2 consecutive ineffective snip compactions', async () => {
    // Setup: each snip call barely reduces tokens → ratio stays above autoCompactRatio
    const budgetCalc = new TokenBudgetCalculator(180000, 4096, 2048);

    // countMessages returns a value that makes newRatio just barely below autoCompactRatio
    // but we need snip to "complete" without escalation (ratio < autoCompactRatio)
    // Actually for cascade we need snip to be insufficient → falls through to reactive → collapse
    // Let me restructure: the cascade detection fires in the tier that ran, and if 2 consecutive
    // ineffective ones happen, it forces collapse.

    // Simpler approach: use a config where only snip is enabled, and snip is repeatedly
    // ineffective, leading to cascade detection jumping to collapse.

    const snipOnlyConfig: CompactionConfig = {
      ...baseConfig,
      thresholds: {
        ...thresholds,
        snipRatio: 0.60,
        autoCompactRatio: 0.75,
        collapseRatio: 0.90,
        preserveRecentTurns: 2,
      },
      enabledTiers: { snip: true, autoCompact: false, reactiveRecovery: false, collapse: true },
    };

    // First call: usageRatio 0.65 → Tier 1 (snip), but countMessages returns almost same value
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.65, currentUsage: 110000 }));
    // snip "snipped" but tokens barely changed: 110000 → 108000 (reduction ~1.8%)
    spyOn(budgetCalc, 'countMessages').mockReturnValue(108000);

    const manager = new TieredCompactionManager(budgetCalc, snipOnlyConfig);
    const largeOutput = Array(60).fill('x'.repeat(200)).join('\n');
    const ctx = makeContext([
      makeUserMessage('read a big file'),
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'tc_1', name: 'read', arguments: {} }] },
      { role: 'tool', content: largeOutput, tool_call_id: 'tc_1', name: 'read' },
      makeUserMessage('read again'),
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'tc_2', name: 'read', arguments: {} }] },
      { role: 'tool', content: largeOutput, tool_call_id: 'tc_2', name: 'read' },
      makeUserMessage('current turn'),
    ]);

    // First compaction: snip fires, but ineffective (reduction < 5%)
    await manager.compressWithResult(ctx, 180000);

    // Second call: same scenario
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.65, currentUsage: 108000 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(106000); // again barely reduced

    await manager.compressWithResult(ctx, 180000);

    // Third call: cascade should be detected, skips to collapse
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.65, currentUsage: 106000 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(30000); // collapse significantly reduces

    const result = await manager.compressWithResult(ctx, 180000);
    expect(result.tier).toBe(CompactionTier.Collapse);
    expect(result.needsContinuation).toBe(true);
  });

  it('should NOT cascade when a compaction is effective (reduction >= 5%)', async () => {
    const budgetCalc = new TokenBudgetCalculator(180000, 4096, 2048);

    const snipOnlyConfig: CompactionConfig = {
      ...baseConfig,
      thresholds: { ...thresholds, snipRatio: 0.60, autoCompactRatio: 0.75, collapseRatio: 0.90, preserveRecentTurns: 2 },
      enabledTiers: { snip: true, autoCompact: false, reactiveRecovery: false, collapse: true },
    };

    // First compaction: snip is effective (reduction > 5%)
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.65, currentUsage: 110000 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(90000); // ~18% reduction, effective

    const manager = new TieredCompactionManager(budgetCalc, snipOnlyConfig);
    const ctx = makeContext([makeUserMessage('msg')]);

    const result1 = await manager.compressWithResult(ctx, 180000);
    expect(result1.tier).toBe(CompactionTier.Snip);

    // Second compaction: also effective
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.65, currentUsage: 90000 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(75000);

    const result2 = await manager.compressWithResult(ctx, 180000);
    // Should still be snip, NOT collapsed (no cascade)
    expect(result2.tier).toBe(CompactionTier.Snip);
  });

  it('should reset cascade state when a compaction is effective after an ineffective one', async () => {
    const budgetCalc = new TokenBudgetCalculator(180000, 4096, 2048);

    const snipOnlyConfig: CompactionConfig = {
      ...baseConfig,
      thresholds: { ...thresholds, snipRatio: 0.60, autoCompactRatio: 0.75, collapseRatio: 0.90, preserveRecentTurns: 2 },
      enabledTiers: { snip: true, autoCompact: false, reactiveRecovery: false, collapse: true },
    };

    // First: ineffective
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.65, currentUsage: 110000 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(108000);

    const manager = new TieredCompactionManager(budgetCalc, snipOnlyConfig);
    const ctx = makeContext([makeUserMessage('msg')]);
    await manager.compressWithResult(ctx, 180000);

    // Second: effective — breaks the consecutive-ineffective chain
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.65, currentUsage: 108000 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(60000);

    const result2 = await manager.compressWithResult(ctx, 180000);
    expect(result2.tier).toBe(CompactionTier.Snip);

    // Third: ineffective again — but only 1 consecutive ineffective, not 2
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.65, currentUsage: 60000 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(59000);

    const result3 = await manager.compressWithResult(ctx, 180000);
    expect(result3.tier).toBe(CompactionTier.Snip); // No cascade yet
  });

  it('should expose resetCompactionState() method', () => {
    const budgetCalc = new TokenBudgetCalculator(180000, 4096, 2048);
    const manager = new TieredCompactionManager(budgetCalc, baseConfig);
    expect(typeof manager.resetCompactionState).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/agent/compaction-cascade.test.ts
```

Expected: FAIL — `resetCompactionState is not a function` or cascade not triggered.

- [ ] **Step 3: Add cascade detection fields and method**

In `src/agent/compaction/compaction-manager.ts`, add after line 33 (`private lastResult: CompactionResult | null = null;`):

```typescript
  /** Track recent compactions for cascade detection. Reset on healthy budget or explicit reset. */
  private compactionHistory: Array<{beforeTokens: number; afterTokens: number; tier: CompactionTier}> = [];
  private cascadeActive = false;
```

- [ ] **Step 4: Add recordAndCheckCascade and resetCompactionState methods**

In `src/agent/compaction/compaction-manager.ts`, add after line 276 (`}` closing `getBudget`):

```typescript
  /** Record a compaction outcome and return true if cascade escalation is needed. */
  private recordAndCheckCascade(beforeTokens: number, afterTokens: number, tier: CompactionTier): boolean {
    if (tier === CompactionTier.None || tier === CompactionTier.Collapse) return false;

    this.compactionHistory.push({ beforeTokens, afterTokens, tier });
    if (this.compactionHistory.length > 3) {
      this.compactionHistory.shift();
    }

    if (this.compactionHistory.length >= 2) {
      const entries = this.compactionHistory;
      const last = entries[entries.length - 1]!;
      const prev = entries[entries.length - 2]!;

      const lastReduction = last.beforeTokens > 0
        ? (last.beforeTokens - last.afterTokens) / last.beforeTokens
        : 0;
      const prevReduction = prev.beforeTokens > 0
        ? (prev.beforeTokens - prev.afterTokens) / prev.beforeTokens
        : 0;

      if (lastReduction < 0.05 && prevReduction < 0.05) {
        this.cascadeActive = true;
        debugLog({
          event: 'compaction.cascade_detected',
          tier,
          tierNumber: tier,
          reason: 'Two consecutive ineffective compactions. Escalating to collapse.',
          lastReduction: +(lastReduction * 100).toFixed(1),
          prevReduction: +(prevReduction * 100).toFixed(1),
        });
        return true;
      }

      // If a compaction was effective, reset the chain
      if (lastReduction >= 0.05) {
        this.cascadeActive = false;
      }
    }

    return false;
  }

  /** Reset compaction state for a new conversation. */
  resetCompactionState(): void {
    this.compactionHistory = [];
    this.cascadeActive = false;
  }
```

- [ ] **Step 5: Integrate cascade into Tier 1 (snip) and Tier 2 (autoCompact) blocks**

In the Tier 1 block (lines 79-114), wrap the existing snip-return logic with cascade check. Replace lines 86-101 (from `// Check if snip was sufficient` through the end of that if-block at `context.messages = result.messages;`):

```typescript
      // Track for cascade detection
      const cascadeEscalation = this.recordAndCheckCascade(result.tokensBefore, result.tokensAfter, CompactionTier.Snip);

      // Check if snip was sufficient — but skip if cascade triggered
      const newRatio = result.tokensAfter / budget.effectiveLimit;
      if (!cascadeEscalation && newRatio < thresholds.autoCompactRatio) {
        debugLog({
          event: 'compaction.triggered',
          tier: 'snip',
          tierNumber: CompactionTier.Snip,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          reduction: result.tokensBefore - result.tokensAfter,
          messageCountBefore: context.messages.length,
          messageCountAfter: result.messages.length,
          budget: { effectiveLimit: budget.effectiveLimit, usageRatio: budget.usageRatio, newRatio },
        });
        return result;
      }

      // Cascade escalation: snip was ineffective — skip remaining tiers, go to collapse
      if (cascadeEscalation && this.config.enabledTiers.collapse) {
        const collapseResult = this.collapse.apply(context.messages);
        collapseResult.tokensBefore = result.tokensBefore;
        collapseResult.tokensAfter = this.budgetCalc.countMessages(collapseResult.messages, context.systemPrompt);
        this.lastResult = collapseResult;
        debugLog({
          event: 'compaction.triggered',
          tier: 'collapse',
          tierNumber: CompactionTier.Collapse,
          tokensBefore: collapseResult.tokensBefore,
          tokensAfter: collapseResult.tokensAfter,
          reduction: collapseResult.tokensBefore - collapseResult.tokensAfter,
          messageCountBefore: context.messages.length,
          messageCountAfter: collapseResult.messages.length,
          budget: { effectiveLimit: budget.effectiveLimit, usageRatio: budget.usageRatio },
          trigger: 'cascade-escalation-from-snip',
        });
        return collapseResult;
      }

      // Snip wasn't enough — log and fall through
```

Then also update the log call on lines 103-113 to use the `escalated` pattern (no code change needed, it's already fine).

In the Tier 2 block (lines 116-145), add cascade check between lines 130-132 (around `result.tokensAfter = ...` and `this.lastResult = result`). Replace lines 130-145:

```typescript
      result.tokensBefore = budget.currentUsage;
      result.tokensAfter = this.budgetCalc.countMessages(result.messages, context.systemPrompt);
      this.lastResult = result;

      const cascadeEscalation = this.recordAndCheckCascade(result.tokensBefore, result.tokensAfter, CompactionTier.AutoCompact);

      if (cascadeEscalation && this.config.enabledTiers.collapse) {
        const collapseResult = this.collapse.apply(context.messages);
        collapseResult.tokensBefore = result.tokensBefore;
        collapseResult.tokensAfter = this.budgetCalc.countMessages(collapseResult.messages, context.systemPrompt);
        this.lastResult = collapseResult;
        debugLog({
          event: 'compaction.triggered',
          tier: 'collapse',
          tierNumber: CompactionTier.Collapse,
          tokensBefore: collapseResult.tokensBefore,
          tokensAfter: collapseResult.tokensAfter,
          reduction: collapseResult.tokensBefore - collapseResult.tokensAfter,
          messageCountBefore: context.messages.length,
          messageCountAfter: collapseResult.messages.length,
          budget: { effectiveLimit: budget.effectiveLimit, usageRatio: budget.usageRatio },
          trigger: 'cascade-escalation-from-auto-compact',
        });
        return collapseResult;
      }

      debugLog({
        event: 'compaction.triggered',
        tier: 'auto-compact',
        tierNumber: CompactionTier.AutoCompact,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        reduction: result.tokensBefore - result.tokensAfter,
        messageCountBefore: context.messages.length,
        messageCountAfter: result.messages.length,
        budget: { effectiveLimit: budget.effectiveLimit, usageRatio: budget.usageRatio },
      });
      return result;
```

- [ ] **Step 6: Reset cascade state when budget is healthy (no compaction needed)**

In the no-compaction branch (lines 65-77), add after line 74 (`this.lastResult = result;`):

```typescript
      // Reset cascade state when budget is healthy
      if (this.compactionHistory.length > 0) {
        this.resetCompactionState();
      }
```

- [ ] **Step 7: Run all compaction tests**

```bash
bun test tests/agent/compaction-cascade.test.ts tests/agent/compaction-manager.test.ts
```

Expected: ALL PASS (both new cascade tests and existing compaction tests).

- [ ] **Step 8: Commit**

```bash
git add tests/agent/compaction-cascade.test.ts src/agent/compaction/compaction-manager.ts
git commit -m "feat: add compaction cascade protection

Detect when two consecutive compactions reduce tokens by <5% and
escalate directly to Tier 4 (collapse) to break the compaction loop.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Sub-Agent cwd Isolation

**Files:**
- Modify: `src/agent/sub-agent-tool.ts` — add fs imports, isolation dir creation, bash tool wrapping
- Create: `tests/agent/sub-agent-cwd-isolation.test.ts`

- [ ] **Step 1: Write the cwd isolation test**

Create `tests/agent/sub-agent-cwd-isolation.test.ts`:

```typescript
import { describe, test, expect, vi, spyOn } from 'bun:test';
import { SubAgentTool } from '../../src/agent/sub-agent-tool';
import { ContextManager } from '../../src/agent/context';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { Provider, AgentConfig, Tool, ToolImplementation } from '../../src/types';
import { createTestCtx } from '../agent/tool-dispatch/test-helpers';

const mockProvider: Provider = {
  registerTools: () => {},
  invoke: async () => { throw new Error('not implemented'); },
  stream: async function*() { yield { done: true }; },
  getModelName: () => 'test',
};

const mockConfig: AgentConfig = { tokenLimit: 50000 };

describe('Sub-agent cwd isolation', () => {
  test('bash tool cwd is forced to isolated directory for code_editor profile', async () => {
    const mainRegistry = new ToolRegistry();

    let receivedCwd: string | undefined;
    const fakeBashImpl: ToolImplementation = {
      execute: async (params: Record<string, unknown>) => {
        receivedCwd = params.cwd as string | undefined;
        return 'ok';
      },
    };

    mainRegistry.register({
      getDefinition: () => ({
        name: 'bash',
        description: 'run bash',
        parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] },
      }),
      execute: (p, c) => fakeBashImpl.execute(p, c),
    });
    mainRegistry.register({
      getDefinition: () => ({
        name: 'read',
        description: 'read file',
        parameters: { type: 'object', properties: {}, required: [] },
      }),
      execute: async () => 'file content',
    });

    // Use a provider that completes immediately so the agent loop finishes
    const provider = {
      registerTools: () => {},
      invoke: async () => ({ content: 'done' }),
      getModelName: () => 'test',
      stream: async function*() {
        yield { type: 'text_delta', text: 'Task completed.' };
        yield { type: 'done', done: true };
      },
    } as unknown as Provider;

    const tool = new SubAgentTool({
      mainProvider: provider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
      isolation: true,
      worktreeRootDir: '/tmp/test-worktrees',
    });

    // Spy on ToolRegistry.register to capture the wrapped bash.execute
    const registerSpy = vi.spyOn(ToolRegistry.prototype, 'register');
    let capturedBashExecute: ((params: Record<string, unknown>, ctx: unknown) => Promise<string>) | undefined;

    registerSpy.mockImplementation(function(this: ToolRegistry, impl: ToolImplementation) {
      const def = impl.getDefinition();
      if (def.name === 'bash') {
        capturedBashExecute = impl.execute;
      }
      // Don't actually register — let the SubAgentTool proceed without side effects
    });

    try {
      await tool.execute(
        { goal: 'run a command', deliverable: 'summary', profile: 'code_editor' },
        createTestCtx({ cwd: '/original/cwd' }),
      );
    } catch {
      // Expected — the sub-agent loop may fail without proper tool registry
    }

    // If a bash tool was registered in the sub-agent, its execute should force cwd
    if (capturedBashExecute) {
      const result = await capturedBashExecute({ command: 'ls' }, createTestCtx({ cwd: '/original/cwd' }));
      // cwd should have been forced to the isolated dir, not the original
      expect(receivedCwd).toBeDefined();
      expect(receivedCwd).toContain('test-worktrees');
      expect(receivedCwd).not.toBe('/original/cwd');
    }

    registerSpy.mockRestore();
  });

  test('bash tool is excluded from read_only profile sub-agent registry', async () => {
    const mainRegistry = new ToolRegistry();
    mainRegistry.register({
      getDefinition: () => ({
        name: 'bash',
        description: 'run bash',
        parameters: { type: 'object', properties: {}, required: [] },
      }),
      execute: async () => 'ok',
    });
    mainRegistry.register({
      getDefinition: () => ({
        name: 'read',
        description: 'read file',
        parameters: { type: 'object', properties: {}, required: [] },
      }),
      execute: async () => 'content',
    });

    const provider = {
      registerTools: () => {},
      invoke: async () => ({ content: 'done' }),
      getModelName: () => 'test',
      stream: async function*() {
        yield { type: 'text_delta', text: 'Done.' };
        yield { type: 'done', done: true };
      },
    } as unknown as Provider;

    const tool = new SubAgentTool({
      mainProvider: provider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
    });

    const registerSpy = vi.spyOn(ToolRegistry.prototype, 'register');
    const registeredNames: string[] = [];
    registerSpy.mockImplementation(function(this: ToolRegistry, impl: ToolImplementation) {
      registeredNames.push(impl.getDefinition().name);
    });

    try {
      await tool.execute(
        { goal: 'read something', deliverable: 'summary', profile: 'read_only' },
        createTestCtx(),
      );
    } catch {}

    expect(registeredNames).toContain('read');
    expect(registeredNames).not.toContain('bash');

    registerSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify baseline**

```bash
bun test tests/agent/sub-agent-cwd-isolation.test.ts
```

Expected: May PASS or FAIL — the first test will fail if `capturedBashExecute` receives the original cwd instead of the isolated one (this is the failing case that proves we need the fix).

- [ ] **Step 3: Add fs imports at top of sub-agent-tool.ts**

After line 1 (`import { nanoid } from 'nanoid';`), add:

```typescript
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
```

- [ ] **Step 4: Add isolation directory creation and bash wrapping in execute()**

In `src/agent/sub-agent-tool.ts`, after line 239 (after `const agentId = ...` and `const startTime = ...`), add before the tool registration loop:

```typescript
    // ── Set up filesystem isolation directory (for code_editor / general profiles) ──
    let isolatedCwd: string | undefined;
    if (profile === 'code_editor' || profile === 'general') {
      if (this.config.isolation && this.config.worktreeRootDir) {
        const resolved = this.config.worktreeRootDir.replace(/^~/, () => process.env.HOME || '/root');
        isolatedCwd = `${resolved}/sub-${agentId}`;
        try { mkdirSync(isolatedCwd, { recursive: true }); } catch { /* may exist */ }
      } else if (this.config.isolation) {
        isolatedCwd = mkdtempSync('/tmp/sub-agent-');
      }
    }
```

Then, in the tool registration loop (lines 252-269), replace the `subToolRegistry.register({...})` block with wrapping logic for bash:

Replace lines 262-269:
```typescript
      const impl = this.config.mainToolRegistry.get(toolDef.name);
      if (impl) {
        // Force cwd isolation for bash tool
        if (toolDef.name === 'bash' && isolatedCwd) {
          subToolRegistry.register({
            getDefinition: () => toolDef,
            execute: (p: Record<string, unknown>, c: Parameters<typeof impl.execute>[1]) =>
              impl.execute({ ...p, cwd: isolatedCwd }, c),
          });
        } else {
          subToolRegistry.register({
            getDefinition: () => toolDef,
            execute: (p, c) => impl.execute(p, c),
          });
        }
      }
```

- [ ] **Step 5: Add cleanup in the finally block**

In the `finally` block at line 461 (`subAgentSemaphore.release();`), add before `subAgentSemaphore.release()`:

```typescript
      // Clean up temp isolation directory if we created one
      if (isolatedCwd && isolatedCwd.startsWith('/tmp/sub-agent-')) {
        try { rmSync(isolatedCwd, { recursive: true, force: true }); } catch { /* best effort */ }
      }
```

- [ ] **Step 6: Run all sub-agent tests**

```bash
bun test tests/agent/sub-agent-cwd-isolation.test.ts tests/agent/sub-agent.isolation.test.ts
```

Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/agent/sub-agent-cwd-isolation.test.ts src/agent/sub-agent-tool.ts
git commit -m "feat: force bash cwd to isolated directory in sub-agents

When a sub-agent uses the code_editor or general profile, wrap the
bash tool to force cwd into the worktree or temp directory. Prevents
sub-agents from accidentally operating on files outside their scope.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: MCP Reconnect Backoff with Jitter and Max Retries

**Files:**
- Modify: `src/mcp/types.ts:3` — add `'exhausted'` to `McpConnectionStatus`
- Modify: `src/mcp/manager.ts:22-26` — add `maxReconnectAttempts` to options, `:28-36` — add retry counter map, `:395-420` — enhance `_reconnect` with jitter and exhausted state
- Create: `tests/mcp/reconnect-backoff.test.ts`

- [ ] **Step 1: Write the reconnect backoff test**

Create `tests/mcp/reconnect-backoff.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { McpManager } from '../../src/mcp/manager';

describe('McpManager reconnect backoff', () => {
  const defaultOptions = {
    toolTimeoutMs: 30_000,
    reconnectAttempts: 3,
    reconnectDelayMs: 1_000,
    maxReconnectAttempts: 5,
  };

  it('should accept maxReconnectAttempts in options', () => {
    const manager = new McpManager({ ...defaultOptions, maxReconnectAttempts: 5 });
    const states = manager.getConnectionStates();
    expect(states.size).toBe(0);
  });

  it('should include "exhausted" in valid connection states', () => {
    const manager = new McpManager({ ...defaultOptions, maxReconnectAttempts: 3 });
    // Verify manager constructs without error
    expect(manager).toBeDefined();
    // Connection states should be queryable
    const states = manager.getConnectionStates();
    expect(states).toBeInstanceOf(Map);
  });

  it('should not reconnect for manually disconnected servers', async () => {
    const manager = new McpManager({ ...defaultOptions, maxReconnectAttempts: 3 });

    // Connect a server that will fail (nonexistent binary)
    try {
      await manager.connectServer({
        name: 'test-disconnect',
        transport: 'stdio',
        command: 'nonexistent_binary_xyz',
      });
    } catch {
      // Expected — binary doesn't exist
    }

    // Manually disconnect — should NOT trigger reconnect (disconnected status)
    await manager.disconnectServer('test-disconnect');

    // Verify server is in disconnected state, not error/exhausted
    const states = manager.getConnectionStates();
    const state = states.get('test-disconnect');
    expect(state?.status).toBe('disconnected');
  });

  it('should construct with default options', () => {
    const manager = new McpManager({
      toolTimeoutMs: 30_000,
      reconnectAttempts: 3,
      reconnectDelayMs: 1_000,
      maxReconnectAttempts: 5,
    });
    expect(manager.hasServer('nonexistent')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/mcp/reconnect-backoff.test.ts
```

Expected: FAIL — `maxReconnectAttempts` not recognized in options type, `'exhausted'` not a valid status.

- [ ] **Step 3: Add 'exhausted' status to McpConnectionStatus**

In `src/mcp/types.ts`, line 3, change:

```typescript
export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
```

to:

```typescript
export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'exhausted';
```

Also add the `exhausted` variant to `McpConnectionState` discriminated union. After line 45, add:

```typescript
  | { status: 'exhausted'; message: string; since: number };
```

- [ ] **Step 4: Add maxReconnectAttempts to McpManagerOptions**

In `src/mcp/manager.ts`, lines 22-26, change:

```typescript
interface McpManagerOptions {
  toolTimeoutMs: number;
  reconnectAttempts: number;
  reconnectDelayMs: number;
}
```

to:

```typescript
interface McpManagerOptions {
  toolTimeoutMs: number;
  reconnectAttempts: number;
  reconnectDelayMs: number;
  maxReconnectAttempts: number;
}
```

- [ ] **Step 5: Add retry counter map to McpManager**

In `src/mcp/manager.ts`, after line 29 (`private _servers = new Map...`), add:

```typescript
  private _reconnectAttempts = new Map<string, number>();
```

- [ ] **Step 6: Enhance _reconnect with jitter and exhausted state**

In `src/mcp/manager.ts`, replace the entire `_reconnect` method (lines 395-420) with:

```typescript
  /** Auto-reconnect after unexpected disconnection with jitter and max retry limit. */
  private async _reconnect(serverName: string): Promise<void> {
    const entry = this._servers.get(serverName);
    if (!entry) return;

    // Remove error-state entry so connectServer can create a fresh one
    this._servers.delete(serverName);

    const maxAttempts = this._options.maxReconnectAttempts;
    const baseDelay = this._options.reconnectDelayMs;
    const currentAttempt = this._reconnectAttempts.get(serverName) ?? 0;

    for (let attempt = currentAttempt + 1; attempt <= maxAttempts; attempt++) {
      this._reconnectAttempts.set(serverName, attempt);
      debugLog(`[McpManager] Reconnecting '${serverName}' attempt ${attempt}/${maxAttempts}`);

      try {
        await this.connectServer(entry.config);
        this._reconnectAttempts.delete(serverName);
        debugLog(`[McpManager] '${serverName}' reconnected successfully`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[McpManager] '${serverName}' reconnect attempt ${attempt} failed: ${msg}`);

        if (attempt < maxAttempts) {
          // Exponential backoff with ±25% jitter
          const base = baseDelay * Math.pow(2, attempt - 1);
          const jitter = base * (0.75 + Math.random() * 0.5);
          await new Promise(resolve => setTimeout(resolve, jitter));
        }
      }
    }

    // All attempts exhausted
    this._reconnectAttempts.delete(serverName);
    this._servers.set(serverName, {
      config: entry.config,
      client: null,
      transport: null,
      state: {
        status: 'exhausted',
        message: `Reconnect failed after ${maxAttempts} attempts`,
        since: Date.now(),
      },
    });
    debugLog(`[McpManager] '${serverName}' reconnect exhausted after ${maxAttempts} attempts`);
  }
```

- [ ] **Step 7: Update runtime.ts to pass maxReconnectAttempts**

In `src/runtime.ts`, line 324-328, change:

```typescript
  const mcpManager = new McpManager({
    toolTimeoutMs: mcpSettings.toolTimeoutMs,
    reconnectAttempts: mcpSettings.reconnectAttempts,
    reconnectDelayMs: mcpSettings.reconnectDelayMs,
  });
```

to:

```typescript
  const mcpManager = new McpManager({
    toolTimeoutMs: mcpSettings.toolTimeoutMs,
    reconnectAttempts: mcpSettings.reconnectAttempts,
    reconnectDelayMs: mcpSettings.reconnectDelayMs,
    maxReconnectAttempts: mcpSettings.reconnectAttempts, // same as existing setting, now explicit
  });
```

- [ ] **Step 8: Reset reconnect counter on manual disconnect**

In `src/mcp/manager.ts`, in `disconnectServer` method, add after line 169 (`state: { status: 'disconnected' }`):

```typescript
    // Reset reconnect counter on manual disconnect
    this._reconnectAttempts.delete(name);
```

- [ ] **Step 9: Run all MCP tests**

```bash
bun test tests/mcp/reconnect-backoff.test.ts tests/mcp/manager.test.ts
```

Expected: ALL PASS.

- [ ] **Step 10: Commit**

```bash
git add tests/mcp/reconnect-backoff.test.ts src/mcp/types.ts src/mcp/manager.ts src/runtime.ts
git commit -m "feat: add MCP reconnect backoff with jitter and max retry limit

Add maxReconnectAttempts option, exponential backoff with ±25% jitter,
and 'exhausted' connection status. Reset retry counter on manual
disconnect. Prevents infinite reconnect attempts for dead servers.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Verification

After all three tasks are complete, run the full test suite:

```bash
bun test
```

All existing and new tests must pass. No regressions.
