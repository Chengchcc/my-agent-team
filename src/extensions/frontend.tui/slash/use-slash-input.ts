import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { keyDispatcher } from "../input/key-dispatcher";
import { PRIORITY } from "../keys/priority";
import { useKeyLayer } from "../keys/use-key-layer";
import fastGlob from "fast-glob";
import {
  type InputEditorState,
  insertTextAtCursor,
  removeCharacterBeforeCursor,
  moveCursorLeft,
  moveCursorRight,
  moveCursorWordLeft,
  moveCursorWordRight,
  moveCursorLineStart,
  moveCursorLineEnd,
  deleteWordBeforeCursor,
} from "../hooks/use-input-editor";
import { useInputHistory } from "../hooks/use-input-history";
import { getFoldedDisplay, hasPasteMarkers, attachmentMap, createPasteMarkerRe, resolvePastePlaceholders } from "../paste-attachments";

import {
  filterCommands,
  getSlashQuery,
  insertSlashCommand,
  getHighlightedCommandName,
  getBestCompletion,
} from '../../../application/slash';

import {
  getAtQuery,
  WELCOME_MESSAGES,
  AT_FILE_GLOB_DEPTH,
  MAX_AT_FILE_RESULTS,
  AT_FILE_DEBOUNCE_MS,
  buildPromptSubmissionTui,
} from './tui-slash-utils';

import type { SlashCommand, PromptSubmission } from '../../../application/slash';
import {
  type PickerState,
} from './input-key-handler';

// ── Hooks for extracted effects ─────────────────────────────────────────────

function useAtFilePicker(atQuery: ReturnType<typeof getAtQuery>) {
  const [atFiles, setAtFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!atQuery) {
      setAtFiles([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fastGlob(`**/*${atQuery.query}*`, {
        cwd: process.cwd(),
        dot: true,
        deep: AT_FILE_GLOB_DEPTH,
        suppressErrors: true,
        onlyFiles: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
      }).then(files => {
        if (!cancelled) setAtFiles(files.slice(0, MAX_AT_FILE_RESULTS));
      }).catch(() => {
        if (!cancelled) setAtFiles([]);
      });
    }, AT_FILE_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atQuery?.query]);
  return atFiles;
}

function useStreamingKeyLayer(streaming: boolean, onAbort: (() => void) | undefined) {
  useEffect(() => {
    if (!streaming || !onAbort) return;
    const handler = (keyEvent: { escape?: boolean }) => {
      if (keyEvent.escape) { onAbort(); return true; }
      return false;
    };
    keyDispatcher.push({ id: 'streaming-mode', handler });
    return () => void keyDispatcher.pop('streaming-mode');
  }, [streaming, onAbort]);
}

function useSlashPickerKeyLayer(
  pickerOpen: boolean,
  filteredCommands: SlashCommand[],
  pickerStateRef: React.MutableRefObject<PickerState>,
) {
  useEffect(() => {
    if (!pickerOpen || filteredCommands.length === 0) return;
    const handler = (keyEvent: { escape?: boolean; return?: boolean; tab?: boolean; upArrow?: boolean; downArrow?: boolean; ctrl?: boolean }) => {
      const s = pickerStateRef.current;
      if (keyEvent.escape) { s.setDismissedQuery(s.slashQuery); return true; }
      if (keyEvent.upArrow && !keyEvent.ctrl) {
        s.setSelectedIndex((index: number) => (index > 0 ? index - 1 : s.filteredCommands.length - 1));
        return true;
      }
      if (keyEvent.downArrow && !keyEvent.ctrl) {
        s.setSelectedIndex((index: number) => (index < s.filteredCommands.length - 1 ? index + 1 : 0));
        return true;
      }
      if (keyEvent.return || keyEvent.tab) {
        if (keyEvent.return && s.editorStateRef.current.text.includes(' ')) {
          s.setDismissedQuery(s.slashQuery);
          return false;
        }
        if (keyEvent.return) {
          s.suppressEnterRef.current = true;
        }
        s.acceptSelectedCommand();
        return true;
      }
      return false;
    };
    keyDispatcher.push({ id: 'slash-picker', handler });
    return () => void keyDispatcher.pop('slash-picker');
  }, [pickerOpen, filteredCommands.length, keyDispatcher, pickerStateRef]);
}

// ── Main hook ───────────────────────────────────────────────────────────────

/* eslint-disable max-lines-per-function */
export function useCommandInput({
  commands,
  streaming,
  onSubmit,
  onAbort,
}: {
  commands: SlashCommand[];
  streaming: boolean;
  onSubmit?: (submission: PromptSubmission) => void | Promise<void>;
  onAbort?: () => void;
}) {
  const [firstMessage, setFirstMessage] = useState(true);
  const [editorState, setEditorState] = useState<InputEditorState>({ text: "", cursorOffset: 0 });
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [dismissedAtQuery, setDismissedAtQuery] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [atSelectedIndex, setAtSelectedIndex] = useState(0);
  const [welcomeMessage] = useState(
    () => WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)] ?? "What's on your mind?",
  );
  const { isBrowsing, beginBrowsing, browseUp, browseDown, exitBrowsing, saveEntry } = useInputHistory();
  const editorStateRef = useRef(editorState);
  useEffect(() => {
    editorStateRef.current = editorState;
  }, [editorState]);

  const suppressEnterRef = useRef(false);

  const slashQuery = getSlashQuery(editorState.text);
  const filteredCommands = useMemo(
    () => (slashQuery === null ? [] : filterCommands(commands, slashQuery)),
    [commands, slashQuery],
  );
  const pickerOpen = slashQuery !== null && dismissedQuery !== slashQuery;
  const highlightedCommandName = getHighlightedCommandName(editorState.text, commands);

  const atQuery = useMemo(() => getAtQuery(editorState.text), [editorState.text]);
  const atFiles = useAtFilePicker(atQuery);
  const atFilePickerOpen = atQuery !== null && dismissedAtQuery !== atQuery.query;

  const hasMarkers = hasPasteMarkers(editorState.text);
  const { displayText, displayCursorOffset, pasteLineCount } = useMemo(() => {
    if (!hasMarkers) {
      return { displayText: editorState.text, displayCursorOffset: editorState.cursorOffset, pasteLineCount: 0 };
    }
    const folded = getFoldedDisplay(editorState.text, editorState.cursorOffset);
    return { displayText: folded.displayText, displayCursorOffset: folded.displayCursorOffset, pasteLineCount: folded.totalPasteLines };
  }, [editorState.text, editorState.cursorOffset, hasMarkers]);

  useEffect(() => {
    setSelectedIndex((currentIndex) => {
      if (filteredCommands.length === 0) return 0;
      return Math.min(currentIndex, filteredCommands.length - 1);
    });
  }, [filteredCommands.length]);

  useEffect(() => { setSelectedIndex(0); }, [slashQuery]);
  useEffect(() => { setAtSelectedIndex(0); }, [atQuery]);
  useEffect(() => { setAtSelectedIndex((index) => Math.min(index, Math.max(0, atFiles.length - 1))); }, [atFiles.length]);

  const dismissIfChanged = useCallback((newText: string) => {
    if (getSlashQuery(newText) !== dismissedQuery) setDismissedQuery(null);
    const q = getAtQuery(newText);
    if (q?.query !== dismissedAtQuery) { setDismissedAtQuery(null); setAtSelectedIndex(0); }
  }, [dismissedQuery, dismissedAtQuery, setDismissedQuery, setDismissedAtQuery, setAtSelectedIndex]);

  const updateEditorState = useCallback((next: InputEditorState | ((prev: InputEditorState) => InputEditorState)) => {
    let newState: InputEditorState;
    if (typeof next === 'function') {
      newState = next(editorStateRef.current);
      setEditorState(newState);
    } else {
      newState = next;
      setEditorState(next);
    }
    dismissIfChanged(newState.text);
    editorStateRef.current = newState;
  }, [setEditorState, dismissIfChanged]);

  const acceptSelectedCommand = useCallback(() => {
    const selectedCommand = filteredCommands[selectedIndex];
    if (!selectedCommand) return;

    updateEditorState({
      text: insertSlashCommand(selectedCommand),
      cursorOffset: insertSlashCommand(selectedCommand).length,
    });
    setSelectedIndex(0);
    if (slashQuery !== null) {
      setDismissedQuery(slashQuery);
    }
  }, [filteredCommands, selectedIndex, updateEditorState, slashQuery, setSelectedIndex, setDismissedQuery]);

  // ── KeyDispatcher: state ref for slash-picker layer ──
  const pickerStateRef = useRef<PickerState>({
    filteredCommands, slashQuery, setSelectedIndex, setDismissedQuery, editorStateRef,
    acceptSelectedCommand, suppressEnterRef,
  });
  useEffect(() => {
    pickerStateRef.current = { filteredCommands, slashQuery, setSelectedIndex, setDismissedQuery, editorStateRef, acceptSelectedCommand, suppressEnterRef };
  }, [filteredCommands, slashQuery, setSelectedIndex, setDismissedQuery, editorStateRef, acceptSelectedCommand, suppressEnterRef]);

  // ── Key layers ──
  useStreamingKeyLayer(streaming, onAbort);
  useSlashPickerKeyLayer(pickerOpen, filteredCommands, pickerStateRef);

  // ── INPUT_EDIT layer (K-1): editor cursor + history keys ──
  useKeyLayer({
    id: 'input-edit',
    priority: PRIORITY.INPUT_EDIT,
    /* eslint-disable-next-line complexity */
    handler: (ev) => {
      // Word jump
      if (ev.key === 'left' && (ev.meta || ev.ctrl)) { updateEditorState(prev => moveCursorWordLeft(prev)); return true; }
      if (ev.key === 'right' && (ev.meta || ev.ctrl)) { updateEditorState(prev => moveCursorWordRight(prev)); return true; }
      // Line start/end
      if (ev.ctrl && ev.key === 'a') { updateEditorState(prev => moveCursorLineStart(prev)); return true; }
      if (ev.ctrl && ev.key === 'e') { updateEditorState(prev => moveCursorLineEnd(prev)); return true; }
      // Delete word
      if (ev.ctrl && ev.key === 'w') { updateEditorState(prev => deleteWordBeforeCursor(prev)); return true; }
      // Codepoint cursor
      if (ev.key === 'left') { updateEditorState(prev => moveCursorLeft(prev)); return true; }
      if (ev.key === 'right') { updateEditorState(prev => moveCursorRight(prev)); return true; }
      // Backspace
      if (ev.key === 'backspace' || ev.key === 'delete') { exitBrowsing(); updateEditorState(prev => removeCharacterBeforeCursor(prev)); return true; }
      // Tab completion
      if (ev.key === 'tab' && editorStateRef.current.text.startsWith('/')) {
        if (!pickerOpen) {
          const completion = getBestCompletion(slashQuery ?? '', commands);
          if (completion) {
            updateEditorState({ text: `/${completion} `, cursorOffset: completion.length + 2 });
            setDismissedQuery(slashQuery);
          } else { setDismissedQuery(null); }
        }
        return true;
      }
      // History browse
      if (!pickerOpen && (editorStateRef.current.text === '' || isBrowsing) && ev.key === 'up' && !ev.ctrl) {
        if (!isBrowsing) beginBrowsing(editorStateRef.current.text);
        const entry = browseUp();
        if (entry !== null) { setEditorState({ text: entry, cursorOffset: entry.length }); }
        return true;
      }
      if (!pickerOpen && isBrowsing && ev.key === 'down' && !ev.ctrl) {
        const entry = browseDown();
        if (entry !== null) { setEditorState({ text: entry, cursorOffset: entry.length }); }
        return true;
      }
      return false;
    },
  });

  // ── FALLTHROUGH layer: text insertion, enter, escape ──
  useKeyLayer({
    id: 'input-fallthrough',
    priority: PRIORITY.FALLTHROUGH,
    handler: (ev) => {
      // Modifier chords don't produce text
      if (ev.ctrl || ev.meta) return false;
      // Named keys don't produce text
      if (['enter', 'escape', 'tab', 'backspace', 'delete', 'up', 'down', 'left', 'right'].includes(ev.key)) {
        if (ev.key === 'enter') {
          // shift+enter = newline
          if (ev.shift) { exitBrowsing(); updateEditorState(prev => insertTextAtCursor(prev, '\n')); return true; }
          // Submit
          const resolvedText = resolvePastePlaceholders(editorStateRef.current.text);
          if (!resolvedText.trim()) return true;
          // S-1: ! prefix → /! slash command rewrite
          const submittedText = resolvedText.startsWith('!')
            ? `/!${resolvedText.slice(1).trimStart() ? ' ' + resolvedText.slice(1).trimStart() : ''}`
            : resolvedText;
          const markerRe = createPasteMarkerRe();
          let m: RegExpExecArray | null;
          while ((m = markerRe.exec(editorStateRef.current.text)) !== null) { attachmentMap.delete(m[1]!); }
          saveEntry(resolvedText);
          void onSubmit?.(buildPromptSubmissionTui(submittedText, commands));
          setEditorState({ text: '', cursorOffset: 0 });
          setDismissedQuery(null);
          setSelectedIndex(0);
          setFirstMessage(false);
          return true;
        }
        if (ev.key === 'escape') {
          if (isBrowsing) {
            const fallback = exitBrowsing();
            const markerRe = createPasteMarkerRe();
            let m: RegExpExecArray | null;
            while ((m = markerRe.exec(editorStateRef.current.text)) !== null) { attachmentMap.delete(m[1]!); }
            setEditorState({ text: fallback ?? '', cursorOffset: fallback?.length ?? 0 });
            setDismissedQuery(null);
            return true;
          }
          if (editorStateRef.current.text.length > 0) {
            exitBrowsing();
            const markerRe = createPasteMarkerRe();
            let m: RegExpExecArray | null;
            while ((m = markerRe.exec(editorStateRef.current.text)) !== null) { attachmentMap.delete(m[1]!); }
            setEditorState({ text: '', cursorOffset: 0 });
            setDismissedQuery(null);
          } else {
            onAbort?.();
          }
          return true;
        }
        // Up/down already handled by INPUT_EDIT if applicable; otherwise suppressed
        if (ev.key === 'up' || ev.key === 'down') return true;
        return false;
      }
      // Bracketed paste passthrough
      if (ev.raw === '[I' || ev.raw === '[O') return false;
      // Strip escape sequences
      if (ev.raw.includes('\x1b')) return true;
      // Insert text character
      exitBrowsing();
      updateEditorState(prev => insertTextAtCursor(prev, ev.raw));
      return true;
    },
  });

  return {
    filteredCommands, highlightedCommandName, pickerOpen,
    placeholder: firstMessage ? welcomeMessage : "Input anything to continue. Launch a new command or skill by typing `/`",
    selectedIndex, text: editorState.text, cursorOffset: editorState.cursorOffset,
    displayText, displayCursorOffset, pasteLineCount, atFiles, atSelectedIndex, atFilePickerOpen,
  };
}
