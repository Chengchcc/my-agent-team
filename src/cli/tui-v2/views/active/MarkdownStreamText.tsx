import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { renderMarkdownTokens } from '../../../tui/utils/render-markdown';

interface MarkdownStreamTextProps {
  content: string;
}

const DEBOUNCE_MS = 50;

class DebounceStore {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private stable: string = '';
  private latest: string = '';

  setValue(newValue: string) {
    this.latest = newValue;
    if (this.latest === this.stable) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.stable = this.latest;
      this.notify();
    }, DEBOUNCE_MS);
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

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const MarkdownStreamText = React.memo(function MarkdownStreamText({ content }: MarkdownStreamTextProps) {
  const storeRef = useRef<DebounceStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new DebounceStore();
  }

  storeRef.current.setValue(content);

  useEffect(() => {
    return () => { storeRef.current?.destroy(); };
  }, []);

  const debouncedContent = useSyncExternalStore(
    storeRef.current.subscribe,
    storeRef.current.getSnapshot,
    () => content,
  );

  const rendered = useMemo(() => {
    if (!debouncedContent) {
      return (
        <Box height={1}>
          <Text>{' '}</Text>
        </Box>
      );
    }
    return renderMarkdownTokens(debouncedContent);
  }, [debouncedContent]);

  return (
    <Box flexDirection="column">
      {rendered}
    </Box>
  );
});
