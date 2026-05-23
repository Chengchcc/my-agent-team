type KeyHandler = (key: KeyEvent) => boolean; // true = consumed, stop propagation

export interface KeyEvent {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  escape?: boolean;
  return?: boolean;
  tab?: boolean;
  shiftTab?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  delete?: boolean;
  backspace?: boolean;
  key?: string;
}

export interface KeyLayer {
  id: string;
  handler: KeyHandler;
  priority?: number;
}

/** Ink `useInput` key shape (subset used by TUI components). */
export interface InkKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  escape?: boolean;
  return?: boolean;
  tab?: boolean;
  shiftTab?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  delete?: boolean;
  backspace?: boolean;
}

/** Convert an Ink useInput `(input: string, key: InkKey)` pair into a canonical KeyEvent. */
export function inkKeyToKeyEvent(input: string, key: InkKey): KeyEvent {
  return {
    upArrow: key.upArrow,
    downArrow: key.downArrow,
    leftArrow: key.leftArrow,
    rightArrow: key.rightArrow,
    escape: key.escape,
    return: key.return,
    tab: key.tab,
    shiftTab: key.shiftTab,
    ctrl: key.ctrl,
    meta: key.meta,
    shift: key.shift,
    delete: key.delete,
    backspace: key.backspace,
    key: input,
  };
}

export class KeyDispatcher {
  private stack: KeyLayer[] = [];

  /** Push a layer onto the stack. If a layer with the same id exists, remove it first (idempotent). */
  push(layer: KeyLayer): void {
    this.pop(layer.id);
    this.stack.push(layer);
  }

  /** Remove a layer by id */
  pop(id: string): void {
    this.stack = this.stack.filter(l => l.id !== id);
  }

  /** Dispatch a key event. Iterates stack top-down (LIFO).
   *  Returns true if the event was consumed by a layer. */
  dispatch(key: KeyEvent): boolean {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i]!.handler(key)) return true;
    }
    return false;
  }

  /** Remove all layers */
  clear(): void {
    this.stack = [];
  }

  /** Current stack depth (for debugging) */
  get depth(): number {
    return this.stack.length;
  }
}
