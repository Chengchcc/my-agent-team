import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { renderMarkdownTokens } from '../../../tui/utils/render-markdown';
import { findStableBoundary } from './findStableBoundary';

interface MarkdownStreamTextProps {
  content: string;
  onStableParagraph?: (chunk: string) => void;
}

const TICK_MS = 33; // ~30fps — smooth for terminal, CPU-friendly
const NO_CONTENT_INDICATOR = 0;

// Leading+trailing throttle: first delta emits immediately, then at most
// once per TICK_MS. Unlike debounce, continuous deltas won't starve the UI.
class ThrottleStore {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private stable = '';
  private latest = '';
  private lastEmit = 0;

  setValue(v: string) {
    this.latest = v;
    if (this.latest === this.stable) return;
    if (!this.timer) {
      const now = Date.now();
      const elapsed = now - this.lastEmit;
      const delay = elapsed >= TICK_MS ? 0 : TICK_MS - elapsed;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.emit();
      }, delay);
    }
  }

  getSnapshot = (): string => this.stable;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  destroy() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  private emit() {
    this.lastEmit = Date.now();
    if (this.latest === this.stable) return;
    this.stable = this.latest;
    for (const l of this.listeners) l();
  }
}

export const MarkdownStreamText = React.memo(function MarkdownStreamText({ content, onStableParagraph }: MarkdownStreamTextProps) {
  const storeRef = useRef<ThrottleStore | null>(null);
  if (!storeRef.current) storeRef.current = new ThrottleStore();

  storeRef.current.setValue(content);

  useEffect(() => () => storeRef.current?.destroy(), []);

  const shown = useSyncExternalStore(
    storeRef.current.subscribe,
    storeRef.current.getSnapshot,
    () => content,
  );

  const { stable, tail } = useMemo(() => {
    const b = findStableBoundary(shown);
    return { stable: shown.slice(0, b), tail: shown.slice(b) };
  }, [shown]);

  const flushedRef = useRef(NO_CONTENT_INDICATOR);
  const isReset = content.length === NO_CONTENT_INDICATOR;

  useEffect(() => {
    if (isReset) flushedRef.current = NO_CONTENT_INDICATOR;
  }, [isReset]);

  // Fire onStableParagraph when the stable portion grows past what we've
  // already flushed to Static. This commits the new stable chunk so the
  // active area stays small and the Ink diff stays minimal.
  useEffect(() => {
    if (!onStableParagraph || stable.length <= flushedRef.current) return;
    const chunk = stable.slice(flushedRef.current);
    flushedRef.current = stable.length;
    onStableParagraph(chunk);
  }, [stable, onStableParagraph]);

  const rendered = useMemo(
    () => (stable ? renderMarkdownTokens(stable) : null),
    [stable],
  );

  if (!stable && !tail) {
    return (
      <Box height={1}>
        <Text>{' '}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {rendered}
      {tail ? <Text>{tail}</Text> : null}
    </Box>
  );
});
