interface KeymapContext {
  streaming: boolean;
  pendingCount: number;
  atFilePickerOpen: boolean;
  pickerOpen: boolean;
}

// ── Callbacks passed from App ──

export interface InputBoxCallbacks {
  onToggleExpand?: () => void;
  onToggleDebug?: () => void;
  onToggleThinking?: () => void;
  onClearPending?: () => void;
}

// ── A single hotkey binding ──

interface Hotkey {
  /** Human-readable label shown in footer hints */
  label: string;
  /** The key name (ink's `input` param) */
  key: string;
  /** Require Ctrl held */
  ctrl?: boolean;
  /** Require Meta held */
  meta?: boolean;
  /** Require Shift held */
  shift?: boolean;
  /** If set, only fires when this condition is true */
  guard?: (ctx: KeymapContext) => boolean;
  /** The callback to invoke */
  handler: () => void;
}

// ── Register all global hotkeys in one place ──

export function buildHotkeys(cbs: {
  onToggleThinking?: () => void;
  onToggleDebug?: () => void;
  onAbort?: () => void;
  onToggleExpand?: () => void;
  onClearPending?: () => void;
}): Hotkey[] {
  return [
    {
      label: 'Ctrl+T',
      key: 't',
      ctrl: true,
      handler: () => cbs.onToggleThinking?.(),
    },
    {
      label: 'Ctrl+D',
      key: 'd',
      ctrl: true,
      handler: () => cbs.onToggleDebug?.(),
    },
    {
      label: 'Esc',
      key: 'escape',
      guard: (ctx) => ctx.streaming,
      handler: () => cbs.onAbort?.(),
    },
    {
      label: 'Ctrl+O',
      key: 'o',
      ctrl: true,
      handler: () => cbs.onToggleExpand?.(),
    },
    {
      label: 'Space',
      key: ' ',
      guard: (ctx) => !ctx.atFilePickerOpen && !ctx.pickerOpen,
      handler: () => cbs.onToggleExpand?.(),
    },
    {
      label: 'Ctrl+K',
      key: 'k',
      ctrl: true,
      guard: (ctx) => ctx.pendingCount > 0,
      handler: () => cbs.onClearPending?.(),
    },
  ];
}

