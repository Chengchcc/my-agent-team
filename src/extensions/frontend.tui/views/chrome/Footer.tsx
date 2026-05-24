import React, { useMemo } from 'react';
import { Text } from 'ink';
import { useTuiStore } from '../../state/store';
import { BUDGET_COMPACT_RATIO, BUDGET_WARN_RATIO, BUDGET_DANGER_RATIO } from '../../../../application/constants/compact';

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
  return marked
}

export function Footer() {
  const contextTokens = useTuiStore(s => s.stats.contextTokens);
  const tokenLimit = useTuiStore(s => s.stats.tokenLimit);
  const completionTokens = useTuiStore(s => s.stats.completionTokens);
  const interrupted = useTuiStore(s => s.stats.interrupted);
  const streaming = useTuiStore(s => s.stats.streaming);
  const toolsExpanded = useTuiStore(s => s.interaction.toolsExpanded);

  const contextPct = tokenLimit > 0 ? contextTokens / tokenLimit : 0;
  const ctxColor = contextPct > BUDGET_DANGER_RATIO ? 'red' as const : contextPct > BUDGET_WARN_RATIO ? 'yellow' as const : undefined;

  const ctxStr = (contextTokens / TOKENS_PER_K).toFixed(1).padStart(CTX_W);
  const limitStr = tokenLimit > 0 ? `${(tokenLimit / TOKENS_PER_K).toFixed(0)}k` : ' ---';
  const pctStr = tokenLimit > 0 ? `${(contextPct * PCT_BASE).toFixed(0).padStart(PCT_W)}%` : ' ---';
  const outStr = `${(completionTokens / TOKENS_PER_K).toFixed(1).padStart(OUT_W)}k`;

  const status = interrupted ? '⚠ interrupted' : streaming ? '● streaming' : '○ idle      ';

  const hints = useMemo(() => {
    const expandLabel = toolsExpanded ? 'spc collapse' : 'spc expand';
    return `↑↓ hist · esc clr · tab · ⇧↵ newline · ${expandLabel} · ctrl+k clr`;
  }, [toolsExpanded]);

  const bar = renderBar(contextPct);
  const barColor = ctxColor ?? 'white';

  const ctxField = <Text color={barColor}>{ctxStr}</Text>;
  const pctField = <Text color={barColor}>{pctStr}</Text>;

  return (
    <Text dimColor>
      {hints}  ctx:{' '}
      <Text color={barColor}>{bar}</Text>
      {' '}
      {ctxField}
      /{limitStr} (
      {pctField}
      )  out:{' '}
      <Text>{outStr}</Text>
      {' '}{status}
    </Text>
  );
}
