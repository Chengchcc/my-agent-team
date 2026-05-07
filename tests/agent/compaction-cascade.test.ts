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
  enabledTiers: { snip: true, autoCompact: false, reactiveRecovery: false, collapse: true },
};

describe('Compaction cascade protection', () => {
  it('should skip to Tier 4 after 2 consecutive ineffective snip compactions', async () => {
    const budgetCalc = new TokenBudgetCalculator(180000, 4096, 2048);

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

    // First call: usageRatio 0.65 -> Tier 1 (snip), but countMessages returns almost same value
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.65, currentUsage: 110000 }));
    // snip "snipped" but tokens barely changed: 110000 -> 108000 (reduction ~1.8%)
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

    // Second call: same scenario - snip ineffective again
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

  it('resetCompactionState() should clear cascade state so no escalation occurs', async () => {
    const budgetCalc = new TokenBudgetCalculator(180000, 4096, 2048);

    const snipOnlyConfig: CompactionConfig = {
      ...baseConfig,
      thresholds: { ...thresholds, snipRatio: 0.60, autoCompactRatio: 0.75, collapseRatio: 0.90, preserveRecentTurns: 2 },
      enabledTiers: { snip: true, autoCompact: false, reactiveRecovery: false, collapse: true },
    };

    // First compaction: ineffective (reduction < 5%)
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.65, currentUsage: 110000 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(108000);

    const manager = new TieredCompactionManager(budgetCalc, snipOnlyConfig);
    const ctx = makeContext([makeUserMessage('msg')]);
    await manager.compressWithResult(ctx, 180000);

    // Second compaction: also ineffective — but first call resetCompactionState()
    // This clears the history, so the second ineffective compaction should NOT trigger cascade
    manager.resetCompactionState();

    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.65, currentUsage: 108000 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(106000);

    const result = await manager.compressWithResult(ctx, 180000);
    // Should still be snip, NOT collapse (because state was reset after first ineffective)
    expect(result.tier).toBe(CompactionTier.Snip);
  });
});
