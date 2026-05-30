import {
  insertTextAtCursor,
  moveCursorLeft,
  moveCursorRight,
  removeCharacterBeforeCursor,
  type InputEditorState,
} from "../hooks/use-input-editor";
import { attachmentMap, createPasteMarkerRe, resolvePastePlaceholders } from "../paste-attachments";
import { handlePasteInput } from '../hooks/paste-handler';
import { getBestCompletion } from '../../../application/slash';
import type { SlashCommand, PromptSubmission } from '../../../application/slash';
import type { getAtQuery } from './tui-slash-utils';
import { buildPromptSubmissionTui } from './tui-slash-utils';

// ── Types ──────────────────────────────────────────────────────────────────

export interface InputKeyHandlerDeps {
  onAbort?: () => void;
  streaming: boolean;
  pickerOpen: boolean;
  slashQuery: string | null;
  setDismissedQuery: React.Dispatch<React.SetStateAction<string | null>>;
  atFilePickerOpen: boolean;
  atQuery: ReturnType<typeof getAtQuery>;
  atFiles: string[];
  setDismissedAtQuery: React.Dispatch<React.SetStateAction<string | null>>;
  isBrowsing: boolean;
  exitBrowsing: () => string | null;
  editorStateRef: React.MutableRefObject<InputEditorState>;
  setEditorState: React.Dispatch<React.SetStateAction<InputEditorState>>;
  updateEditorState: (next: InputEditorState | ((prev: InputEditorState) => InputEditorState)) => void;
  atSelectedIndex: number;
  setAtSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  suppressEnterRef: React.MutableRefObject<boolean>;
  commands: SlashCommand[];
  onSubmit?: (submission: PromptSubmission) => void | Promise<void>;
  saveEntry: (text: string) => void;
  setFirstMessage: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  hasMarkers: boolean;
  beginBrowsing: (text: string) => void;
  browseUp: () => string | null;
  browseDown: () => string | null;
}

export interface PickerState {
  filteredCommands: SlashCommand[];
  slashQuery: string | null;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  setDismissedQuery: React.Dispatch<React.SetStateAction<string | null>>;
  editorStateRef: React.MutableRefObject<InputEditorState>;
  acceptSelectedCommand: () => void;
  suppressEnterRef: React.MutableRefObject<boolean>;
}

// ── Key handler ────────────────────────────────────────────────────────────

/* eslint-disable complexity */
export function makeInputKeyHandler(d: InputKeyHandlerDeps) {
  return (input: string, key: {

    ctrl: boolean; escape: boolean; upArrow: boolean; downArrow: boolean;
    leftArrow: boolean; rightArrow: boolean; return: boolean; tab: boolean;
    shift: boolean; backspace: boolean; delete: boolean;
  }) => {
    // Ctrl+C and streaming ESC handled by KeyDispatcher GLOBAL_CHROME layer

    if (d.pickerOpen && key.escape) { d.setDismissedQuery(d.slashQuery); return; }

    if (d.atFilePickerOpen && key.escape) { d.setDismissedAtQuery(d.atQuery!.query); return; }

    if (key.escape) {
      if (d.isBrowsing) {
        const fallback = d.exitBrowsing();
        const markerRe = createPasteMarkerRe();
        let m: RegExpExecArray | null;
        while ((m = markerRe.exec(d.editorStateRef.current.text)) !== null) {
          attachmentMap.delete(m[1]!);
        }
        d.setEditorState({ text: fallback ?? '', cursorOffset: fallback?.length ?? 0 });
        d.setDismissedQuery(null);
        return;
      }
      if (d.editorStateRef.current.text.length > 0) {
        d.exitBrowsing();
        const markerRe = createPasteMarkerRe();
        let m: RegExpExecArray | null;
        while ((m = markerRe.exec(d.editorStateRef.current.text)) !== null) {
          attachmentMap.delete(m[1]!);
        }
        d.setEditorState({ text: '', cursorOffset: 0 });
        d.setDismissedQuery(null);
      } else {
        d.onAbort?.();
      }
      return;
    }

    if (d.atFilePickerOpen && key.upArrow && !key.ctrl) {
      d.setAtSelectedIndex((index) => (index > 0 ? index - 1 : d.atFiles.length - 1));
      return;
    }
    if (d.atFilePickerOpen && key.downArrow && !key.ctrl) {
      d.setAtSelectedIndex((index) => (index < d.atFiles.length - 1 ? index + 1 : 0));
      return;
    }

    if (key.tab && d.editorStateRef.current.text.startsWith('/')) {
      if (!d.pickerOpen) {
        const completion = getBestCompletion(d.slashQuery ?? '', d.commands);
        if (completion) {
          d.updateEditorState({ text: `/${completion} `, cursorOffset: completion.length + 2 });
          d.setDismissedQuery(d.slashQuery);
        } else {
          d.setDismissedQuery(null);
        }
      }
      return;
    }

    if ((key.tab || key.return) && d.atQuery && d.atFiles.length > 0) {
      if (!d.atFilePickerOpen && key.return) {
        // Enter without open picker — don't intercept
      } else {
        const file = d.atFiles[d.atSelectedIndex]!;
        const before = d.editorStateRef.current.text.slice(0, d.atQuery.start);
        const text = before + file + ' ';
        d.updateEditorState({ text, cursorOffset: text.length });
        d.setDismissedAtQuery(d.atQuery.query);
        return;
      }
    }

    if (key.return) {
      if (d.suppressEnterRef.current) { d.suppressEnterRef.current = false; return; }
      if (key.shift) { d.exitBrowsing(); d.updateEditorState(prev => insertTextAtCursor(prev, '\n')); return; }

      const resolvedText = resolvePastePlaceholders(d.editorStateRef.current.text);
      if (!resolvedText.trim()) return;
      const markerRe = createPasteMarkerRe();
      let m: RegExpExecArray | null;
      while ((m = markerRe.exec(d.editorStateRef.current.text)) !== null) {
        attachmentMap.delete(m[1]!);
      }
      d.saveEntry(resolvedText);
      void d.onSubmit?.(buildPromptSubmissionTui(resolvedText, d.commands));
      d.setEditorState({ text: "", cursorOffset: 0 });
      d.setDismissedQuery(null);
      d.setSelectedIndex(0);
      d.setFirstMessage(false);
      return;
    }

    if (handlePasteInput({
      input, key,
      editorRef: d.editorStateRef,
      hasMarkers: d.hasMarkers,
      updateEditorState: d.updateEditorState,
      exitBrowsing: d.exitBrowsing,
    })) return;

    if (key.leftArrow) { d.updateEditorState(prev => moveCursorLeft(prev)); return; }
    if (key.rightArrow) { d.updateEditorState(prev => moveCursorRight(prev)); return; }
    if (key.backspace || key.delete) { d.exitBrowsing(); d.updateEditorState(prev => removeCharacterBeforeCursor(prev)); return; }

    if (!d.pickerOpen && (d.editorStateRef.current.text === "" || d.isBrowsing) && key.upArrow && !key.ctrl) {
      if (!d.isBrowsing) d.beginBrowsing(d.editorStateRef.current.text);
      const entry = d.browseUp();
      if (entry !== null) { d.setEditorState({ text: entry, cursorOffset: entry.length }); }
      return;
    }
    if (!d.pickerOpen && d.isBrowsing && key.downArrow && !key.ctrl) {
      const entry = d.browseDown();
      if (entry !== null) { d.setEditorState({ text: entry, cursorOffset: entry.length }); }
      return;
    }
    if ((key.upArrow || key.downArrow) && !key.ctrl) return;

    d.exitBrowsing();
    if (input.includes('\x1b') || input === '[I' || input === '[O') return;
    d.updateEditorState(prev => insertTextAtCursor(prev, input));
  };
}
/* eslint-enable complexity */
