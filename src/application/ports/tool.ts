import type { ToolContext } from './tool-context';

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parse?: (raw: Record<string, unknown>) => Record<string, unknown>;
  execute: (ctx: ToolContext, params: Record<string, unknown>) => Promise<unknown>;
  readonly?: boolean;
  conflictKey?: (toolCtx: ToolContext, input: unknown) => string | null;
  /** Max output bytes — tool must self-truncate and append <truncated bytes=N/> marker. */
  outputCap?: number;
  /** Hint for TUI rendering: 'widget' means skip default tool view and use a custom widget. */
  renderHint?: 'widget' | 'default';
}
