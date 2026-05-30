export interface InputEditorState {
  text: string;
  cursorOffset: number;
}

function prevCodePointOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= 2 && text.codePointAt(offset - 2) !== text.charCodeAt(offset - 2)) return offset - 2;
  return offset - 1;
}

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

function nextCodePointOffset(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const code = text.charCodeAt(offset);
  if (code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX) return offset + 2;
  return offset + 1;
}

export function insertTextAtCursor(state: InputEditorState, input: string): InputEditorState {
  if (input.length === 0) return state;

  return {
    text: state.text.slice(0, state.cursorOffset) + input + state.text.slice(state.cursorOffset),
    cursorOffset: state.cursorOffset + input.length,
  };
}

export function removeCharacterBeforeCursor(state: InputEditorState): InputEditorState {
  if (state.cursorOffset === 0) return state;
  const cutAt = prevCodePointOffset(state.text, state.cursorOffset);

  return {
    text: state.text.slice(0, cutAt) + state.text.slice(state.cursorOffset),
    cursorOffset: cutAt,
  };
}

export function moveCursorLeft(state: InputEditorState): InputEditorState {
  return {
    ...state,
    cursorOffset: prevCodePointOffset(state.text, state.cursorOffset),
  };
}

export function moveCursorRight(state: InputEditorState): InputEditorState {
  return {
    ...state,
    cursorOffset: nextCodePointOffset(state.text, state.cursorOffset),
  };
}

const WORD_RE = /[\p{L}\p{N}_]/u;

export function moveCursorWordLeft(state: InputEditorState): InputEditorState {
  if (state.cursorOffset <= 0) return state;
  let pos = state.cursorOffset;
  // Skip trailing whitespace
  while (pos > 0 && /\s/u.test(state.text[pos - 1]!)) pos--;
  // Skip word chars
  while (pos > 0 && WORD_RE.test(state.text[pos - 1]!)) pos--;
  return { ...state, cursorOffset: pos };
}

export function moveCursorWordRight(state: InputEditorState): InputEditorState {
  if (state.cursorOffset >= state.text.length) return state;
  let pos = state.cursorOffset;
  // Skip word chars
  while (pos < state.text.length && WORD_RE.test(state.text[pos]!)) pos++;
  // Skip whitespace
  while (pos < state.text.length && /\s/u.test(state.text[pos]!)) pos++;
  return { ...state, cursorOffset: pos };
}

export function moveCursorLineStart(state: InputEditorState): InputEditorState {
  const before = state.text.slice(0, state.cursorOffset);
  const lastNewline = before.lastIndexOf('\n');
  return { ...state, cursorOffset: lastNewline === -1 ? 0 : lastNewline + 1 };
}

export function moveCursorLineEnd(state: InputEditorState): InputEditorState {
  const nextNewline = state.text.indexOf('\n', state.cursorOffset);
  return { ...state, cursorOffset: nextNewline === -1 ? state.text.length : nextNewline };
}

export function deleteWordBeforeCursor(state: InputEditorState): InputEditorState {
  if (state.cursorOffset <= 0) return state;
  const afterMove = moveCursorWordLeft(state);
  return {
    text: state.text.slice(0, afterMove.cursorOffset) + state.text.slice(state.cursorOffset),
    cursorOffset: afterMove.cursorOffset,
  };
}

