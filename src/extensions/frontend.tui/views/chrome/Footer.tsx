import React from 'react';
import { Box, Text } from 'ink';
import { useTuiStore } from '../../state/store';
import { BUDGET_COMPACT_RATIO, BUDGET_WARN_RATIO, BUDGET_DANGER_RATIO } from '../../../../application/constants/compact';
import { GLOBAL_BINDINGS } from '../../keys/global-keymap';

const TOKENS_PER_K = 1000;
const BAR_WIDTH = 10;
const PCT_BASE = 100;
const CTX_W = 5;
const PCT_W = 3;
const OUT_W = 5;

function renderBar(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * BAR_WIDTH);
  const bar = '▓'.repeat(filled) + '░'.repeat(Math.max(0, BAR_WIDTH - filled));
  const cmark = Math.round(BUDGET_COMPACT_RATIO * BAR_WIDTH);
  const dmark = Math.round(BUDGET_DANGER_RATIO * BAR_WIDTH);
  let marked = '';
  for (let i = 0; i < BAR_WIDTH; i++) {
    const isCMark = i > 0 && i === cmark;
    const isDMark = i > 0 && i === dmark;
    if (isCMark && isDMark) marked += '┼';
    else if (isCMark) marked += '│';
    else if (isDMark) marked += '│';
    else marked += bar[i];
  }
  return marked;
}

export function Footer() {
  const contextTokens = useTuiStore(s => s.stats.lastTurnInputTokens);
  const tokenLimit = useTuiStore(s => s.stats.tokenLimit);
  const completionTokens = useTuiStore(s => s.stats.completionTokens);
  const interrupted = useTuiStore(s => s.stats.interrupted);
  const streaming = useTuiStore(s => s.stats.streaming);
  const compacting = useTuiStore(s => s.stats.compacting);
  const contextPct = tokenLimit > 0 ? contextTokens / tokenLimit : 0;
  const ctxColor = contextPct > BUDGET_DANGER_RATIO ? 'red' as const : contextPct > BUDGET_WARN_RATIO ? 'yellow' as const : undefined;

  const ctxStr = (contextTokens / TOKENS_PER_K).toFixed(1).padStart(CTX_W);
  const limitStr = tokenLimit > 0 ? `${(tokenLimit / TOKENS_PER_K).toFixed(0)}k` : ' ---';
  const pctStr = tokenLimit > 0 ? `${(contextPct * PCT_BASE).toFixed(0).padStart(PCT_W)}%` : ' ---';
  const outStr = completionTokens > 0 ? `${(completionTokens / TOKENS_PER_K).toFixed(1).padStart(OUT_W)}k` : '';

  const statusBadge = compacting
    ? <Text color="yellow">⟳ compacting</Text>
    : interrupted
    ? <Text color="red">⚠ interrupted</Text>
    : streaming
    ? <Text color="green">● streaming</Text>
    : <Text dimColor>○ idle</Text>;

  const footerBindings = GLOBAL_BINDINGS
    .filter(b => b.showInFooter)
    .sort((a, b) => (a.hintPriority ?? 99) - (b.hintPriority ?? 99));
  const hintStr = footerBindings.map(b => b.label.toLowerCase()).join(' · ');

  const bar = renderBar(contextPct);
  const barColor = ctxColor ?? 'white';

  return (
    <Box flexDirection="row" width="100%">
      <Box flexGrow={1} overflow="hidden">
        <Text dimColor>{hintStr}</Text>
      </Box>
      <Box marginX={1}>
        <Text dimColor={streaming}>ctx: </Text>
        <Text color={barColor} dimColor={streaming}>{bar}</Text>
        <Text dimColor={streaming}> {ctxStr}/{limitStr} ({pctStr})</Text>
        {outStr ? <Text dimColor> out: </Text> : null}
        {outStr ? <Text>{outStr}</Text> : null}
      </Box>
      <Box width={14}>{statusBadge}</Box>
    </Box>
  );
}
