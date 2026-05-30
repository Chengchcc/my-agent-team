import type { InkKey, KeyEvent } from '../input/key-dispatcher';

export function normalizeKey(input: string, key: InkKey): KeyEvent {
  const named: string | undefined =
    key.return ? 'enter' :
    key.escape ? 'escape' :
    key.tab ? 'tab' :
    key.backspace ? 'backspace' :
    key.delete ? 'delete' :
    key.upArrow ? 'up' :
    key.downArrow ? 'down' :
    key.leftArrow ? 'left' :
    key.rightArrow ? 'right' :
    key.pageUp ? 'pageup' :
    key.pageDown ? 'pagedown' :
    undefined;

  // macOS option+← dual-fallback: key.meta=true OR escape sequence
  if (input === '\x1bb' || input === '\x1b[1;3D') {
    return { key: 'left', ctrl: !!key.ctrl, meta: true, shift: !!key.shift, raw: input };
  }
  if (input === '\x1bf' || input === '\x1b[1;3C') {
    return { key: 'right', ctrl: !!key.ctrl, meta: true, shift: !!key.shift, raw: input };
  }

  return {
    key: named ?? input,
    ctrl: !!key.ctrl,
    meta: !!key.meta,
    shift: !!key.shift,
    raw: input,
  };
}
