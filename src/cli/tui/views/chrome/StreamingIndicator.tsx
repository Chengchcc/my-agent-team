import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { useStatsSelector } from '../../state/selectors';

const MS_PER_SECOND = 1000;
const TICK_MS = 250;
const SECS_WIDTH = 3;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function StreamingIndicator() {
  const streaming = useStatsSelector(s => s.streaming);
  const streamingStartTime = useStatsSelector(s => s.streamingStartTime);
  const interrupted = useStatsSelector(s => s.interrupted);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => setTick(t => t + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [streaming]);

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
