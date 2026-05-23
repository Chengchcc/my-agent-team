import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { useTuiStore } from '../../state/store';

const MS_PER_SECOND = 1000;
const TICK_MS = 250;
const SECS_WIDTH = 3;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function StreamingIndicator() {
  const streaming = useTuiStore(s => s.stats.streaming);
  const streamingStartTime = useTuiStore(s => s.stats.streamingStartTime);
  const interrupted = useTuiStore(s => s.stats.interrupted);
  const compacting = useTuiStore(s => s.stats.compacting);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!streaming && !compacting) return;
    const timer = setInterval(() => setTick(t => t + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [streaming, compacting]);

  if (compacting) {
    const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
    return <Text color="cyan">{frame} Compacting context...</Text>;
  }

  if (!streaming && !interrupted) return <Text>{' '}</Text>;

  const elapsed = streamingStartTime
    ? Math.floor((Date.now() - streamingStartTime) / MS_PER_SECOND)
    : 0;
  const elapsedStr = String(elapsed).padStart(SECS_WIDTH);

  if (interrupted) {
    return <Text color="yellow">{'⚠'} interrupted after {elapsedStr}s</Text>;
  }

  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
  return <Text color="yellow">{frame} thinking ({elapsedStr}s)</Text>;
}
