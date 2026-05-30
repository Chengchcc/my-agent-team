export interface GlobalKeyCtx {
  streaming: boolean;
  pendingCount: number;
  inputFocused: boolean;
  mode: string;
}

export interface GlobalBinding {
  id: string;
  label: string;
  description: string;
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  scope: 'global' | 'modal-trigger';
  hintPriority?: number;
  showInFooter?: boolean;
  guard?: (ctx: GlobalKeyCtx) => boolean;
  action: string;
}

export const GLOBAL_BINDINGS: ReadonlyArray<GlobalBinding> = [
  {
    id: 'ctrl-c',
    label: 'Ctrl+C×2',
    description: 'Exit (or abort streaming)',
    key: 'c',
    ctrl: true,
    scope: 'global',
    showInFooter: true,
    hintPriority: 100,
    action: 'exit-or-abort',
  },
  {
    id: 'esc-abort',
    label: 'Esc',
    description: 'Interrupt streaming',
    key: 'escape',
    scope: 'global',
    guard: (ctx) => ctx.streaming,
    showInFooter: true,
    hintPriority: 90,
    action: 'abort',
  },
  {
    id: 'ctrl-t',
    label: 'Ctrl+T',
    description: 'Toggle thinking display',
    key: 't',
    ctrl: true,
    scope: 'global',
    action: 'toggle-thinking',
  },
  {
    id: 'ctrl-d',
    label: 'Ctrl+D',
    description: 'Toggle debug display',
    key: 'd',
    ctrl: true,
    scope: 'global',
    action: 'toggle-debug',
  },
  {
    id: 'ctrl-o',
    label: 'Ctrl+O',
    description: 'Toggle tool details',
    key: 'o',
    ctrl: true,
    scope: 'global',
    action: 'toggle-expand',
  },
  {
    id: 'space-expand',
    label: 'Space',
    description: 'Toggle tool details (when not in input)',
    key: ' ',
    scope: 'global',
    guard: (ctx) => !ctx.inputFocused,
    action: 'toggle-expand',
  },
  {
    id: 'ctrl-k',
    label: 'Ctrl+K',
    description: 'Clear pending queue',
    key: 'k',
    ctrl: true,
    scope: 'global',
    guard: (ctx) => ctx.pendingCount > 0,
    showInFooter: true,
    hintPriority: 60,
    action: 'clear-pending',
  },
  {
    id: 'cheatsheet',
    label: '?',
    description: 'Show keyboard shortcuts',
    key: '?',
    scope: 'modal-trigger',
    guard: (ctx) => !ctx.inputFocused,
    showInFooter: true,
    hintPriority: 50,
    action: 'open-cheatsheet',
  },
];
