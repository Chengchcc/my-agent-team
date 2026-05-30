import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { useTuiStore } from '../../state/store';
import { useSpinner } from '../../components/use-spinner';

const TICK_MS = 250;
const MS_PER_SECOND = 1000;
const SECS_WIDTH = 3;

export function StreamingIndicator() {
  const streaming = useTuiStore(s => s.stats.streaming);
  const streamingStartTime = useTuiStore(s => s.stats.streamingStartTime);
  const interrupted = useTuiStore(s => s.stats.interrupted);
  const compacting = useTuiStore(s => s.stats.compacting);

  const frame = useSpinner(streaming || compacting);

  // Re-render tick for elapsed time display
  const [_tick, setTick] = useState(0);
  void _tick;
  useEffect(() => {
    if (!streaming && !compacting) return;
    const timer = setInterval(() => setTick(t => t + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [streaming, compacting]);

  if (compacting) {
    return <Text color="cyan">{frame} Compacting context...</Text>;
  }

  if (!streaming && !interrupted) return <Text>{' '}</Text>;

  const elapsed = streamingStartTime
    ? Math.floor((Date.now() - streamingStartTime) / MS_PER_SECOND)
    : 0;
  const elapsedStr = String(elapsed).padStart(SECS_WIDTH);

  if (interrupted) {
    return <Text color="yellow">{'\u26A0'} interrupted after {elapsedStr}s</Text>;
  }

  return <Text color="yellow">{frame} thinking ({elapsedStr}s)</Text>;
}
