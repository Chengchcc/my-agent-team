type KeyHandler = (key: KeyEvent) => boolean; // true = consumed, stop propagation

export interface KeyEvent {
  /** Normalized key name: 't', 'enter', 'escape', 'up', etc. */
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** Original input string from Ink (for paste/IME detection) */
  raw: string;
}

export interface KeyLayer {
  id: string;
  handler: KeyHandler;
  priority?: number;
  /** Dynamic gate. If present and returns false, this layer is skipped in dispatch. */
  when?: () => boolean;
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
  pageUp?: boolean;
  pageDown?: boolean;
}

export class KeyDispatcher {
  private stack: KeyLayer[] = [];

  /**
   * Push a layer onto the stack, sorted by priority descending.
   * If a layer with the same id exists, remove it first (idempotent).
   * Layers with the same priority are ordered LIFO within that priority group.
   */
  push(layer: KeyLayer): void {
    this.pop(layer.id);
    const prio = layer.priority ?? 0;
    let i = 0;
    for (; i < this.stack.length; i++) {
      if ((this.stack[i]!.priority ?? 0) <= prio) break;
    }
    this.stack.splice(i, 0, layer);
  }

  /** Remove a layer by id */
  pop(id: string): void {
    this.stack = this.stack.filter(l => l.id !== id);
  }

  /**
   * Dispatch a key event. Iterates stack top-down (LIFO within same priority).
   * Skips layers whose when() gate returns false.
   * Returns true if the event was consumed by a layer.
   */
  dispatch(key: KeyEvent): boolean {
    for (let i = 0; i < this.stack.length; i++) {
      const layer = this.stack[i]!;
      if (layer.when && !layer.when()) continue;
      if (layer.handler(key)) return true;
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

/** Module-level singleton — the TUI has exactly one KeyDispatcher. */
export const keyDispatcher = new KeyDispatcher();
