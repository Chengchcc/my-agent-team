/* eslint-disable complexity */
import { attachmentMap, createPasteMarker, createPasteMarkerRe, resolvePastePlaceholders } from '../paste-attachments';
import { insertTextAtCursor, removeCharacterBeforeCursor, moveCursorLeft, moveCursorRight, type InputEditorState } from './use-input-editor';

export const PASTE_FOLD_LINE_THRESHOLD = 3;
export const PASTE_FOLD_CHAR_THRESHOLD = 200;

export function findMarkerAtCursor(text: string, cursor: number): { id: string; start: number; end: number } | null {
  const re = createPasteMarkerRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (cursor > start && cursor < end) {
      return { id: m[1]!, start, end };
    }
  }
  return null;
}

export interface PasteHandlerOptions {
  input: string;
  key: { backspace?: boolean; delete?: boolean; leftArrow?: boolean; rightArrow?: boolean; ctrl?: boolean; meta?: boolean };
  editorRef: { current: InputEditorState };
  hasMarkers: boolean;
  updateEditorState: (next: InputEditorState | ((prev: InputEditorState) => InputEditorState)) => void;
  exitBrowsing: () => void;
}

/** Returns true if the input was fully handled. */
export function handlePasteInput(opts: PasteHandlerOptions): boolean {
  const { input, key, editorRef, hasMarkers, updateEditorState, exitBrowsing } = opts;

  // Detect tagged paste chunk from PasteBufferingStdin.
  const pasteMatch = /^\x01PASTE\x01([\w-]+)\x01([\s\S]*?)\x01$/.exec(input);
  if (pasteMatch) {
    const id = pasteMatch[1]!;
    const content = pasteMatch[2]!;
    const lineCount = content.split('\n').length;
    if (lineCount > PASTE_FOLD_LINE_THRESHOLD || content.length > PASTE_FOLD_CHAR_THRESHOLD) {
      attachmentMap.set(id, content);
      exitBrowsing();
      const marker = createPasteMarker(id);
      updateEditorState(prev => insertTextAtCursor(prev, marker));
    } else {
      exitBrowsing();
      updateEditorState(prev => insertTextAtCursor(prev, content));
    }
    return true;
  }

  if (!hasMarkers) return false;

  const markerAtCursor = findMarkerAtCursor(editorRef.current.text, editorRef.current.cursorOffset);

  // Space inside a marker: expand all markers
  if (input === ' ' && markerAtCursor) {
    const resolved = resolvePastePlaceholders(editorRef.current.text);
    updateEditorState({ text: resolved, cursorOffset: resolved.length });
    return true;
  }

  // Backspace/Delete near a marker
  if (key.backspace || key.delete) {
    let markerToRemove: { id: string; start: number; end: number } | null = null;
    const cursor = editorRef.current.cursorOffset;
    const deletePos = key.backspace ? cursor - 1 : cursor;
    if (deletePos >= 0) {
      const markerRe = createPasteMarkerRe();
      let match: RegExpExecArray | null;
      while ((match = markerRe.exec(editorRef.current.text)) !== null) {
        const mStart = match.index;
        const mEnd = mStart + match[0].length;
        if (deletePos >= mStart && deletePos < mEnd) {
          markerToRemove = { id: match[1]!, start: mStart, end: mEnd };
          break;
        }
      }
    }
    if (markerToRemove) {
      const before = editorRef.current.text.slice(0, markerToRemove.start);
      const after = editorRef.current.text.slice(markerToRemove.end);
      attachmentMap.delete(markerToRemove.id);
      updateEditorState({ text: before + after, cursorOffset: markerToRemove.start });
    } else {
      updateEditorState(prev => removeCharacterBeforeCursor(prev));
    }
    return true;
  }

  // Arrow navigation across markers
  if (key.leftArrow) {
    const cursor = editorRef.current.cursorOffset;
    if (markerAtCursor) {
      updateEditorState({ text: editorRef.current.text, cursorOffset: markerAtCursor.start });
    } else if (cursor > 0) {
      const peek = findMarkerAtCursor(editorRef.current.text, cursor - 1);
      if (peek) {
        updateEditorState({ text: editorRef.current.text, cursorOffset: peek.start });
      } else {
        updateEditorState(prev => moveCursorLeft(prev));
      }
    }
    return true;
  }

  if (key.rightArrow) {
    const cursor = editorRef.current.cursorOffset;
    if (markerAtCursor) {
      updateEditorState({ text: editorRef.current.text, cursorOffset: markerAtCursor.end });
    } else if (cursor < editorRef.current.text.length) {
      const peek = findMarkerAtCursor(editorRef.current.text, cursor);
      if (peek && cursor === peek.start - 1) {
        updateEditorState({ text: editorRef.current.text, cursorOffset: peek.end });
      } else {
        updateEditorState(prev => moveCursorRight(prev));
      }
    }
    return true;
  }

  // Block character input inside marker
  if (markerAtCursor && input && !key.ctrl && !key.meta) {
    return true;
  }

  return false;
}
