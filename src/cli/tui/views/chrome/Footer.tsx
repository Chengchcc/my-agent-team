import React, { useMemo } from 'react';
import { Text } from 'ink';
import { useTuiStore } from '../../state/store';

const TOKENS_PER_K = 1000;
const CTX_DANGER_PCT = 0.9;
const CTX_WARN_PCT = 0.7;
const PCT_BASE = 100;
const CTX_W = 5;
const PCT_W = 3;
const OUT_W = 5;

export function Footer() {
  const contextTokens = useTuiStore(s => s.stats.contextTokens);
  const tokenLimit = useTuiStore(s => s.stats.tokenLimit);
  const completionTokens = useTuiStore(s => s.stats.completionTokens);
  const interrupted = useTuiStore(s => s.stats.interrupted);
  const streaming = useTuiStore(s => s.stats.streaming);
  const focusedToolId = useTuiStore(s => s.interaction.focusedToolId);

  const contextPct = tokenLimit > 0 ? contextTokens / tokenLimit : 0;
  const ctxColor = contextPct > CTX_DANGER_PCT ? 'red' as const : contextPct > CTX_WARN_PCT ? 'yellow' as const : null;

  const ctxStr = (contextTokens / TOKENS_PER_K).toFixed(1).padStart(CTX_W);
  const limitStr = tokenLimit > 0 ? `${(tokenLimit / TOKENS_PER_K).toFixed(0)}k` : ' ---';
  const pctStr = tokenLimit > 0 ? `${(contextPct * PCT_BASE).toFixed(0).padStart(PCT_W)}%` : ' ---';
  const outStr = `${(completionTokens / TOKENS_PER_K).toFixed(1).padStart(OUT_W)}k`;

  const status = interrupted ? '⚠ interrupted' : streaming ? '● streaming' : '○ idle      ';

  const hints = useMemo(() => {
    const parts = ['↑↓ hist · esc clr · ctrl+↑↓ focus · tab'];
    if (focusedToolId) parts.push('space: expand');
    return parts.join(' · ');
  }, [focusedToolId]);

  const ctxField = ctxColor
    ? <Text color={ctxColor}>{ctxStr}</Text>
    : <Text>{ctxStr}</Text>;

  const pctField = ctxColor
    ? <Text color={ctxColor}>{pctStr}</Text>
    : <Text>{pctStr}</Text>;

  // Fixed-width layout — no flex, no gap, no justify-content.
  // Every numeric field uses padStart so digit changes don't shift column boundaries.
  return (
    <Text dimColor>
      {hints}  ctx:{' '}
      {ctxField}
      /{limitStr} (
      {pctField}
      )  out:{' '}
      <Text>{outStr}</Text>
      {' '}{status}
    </Text>
  );
}
