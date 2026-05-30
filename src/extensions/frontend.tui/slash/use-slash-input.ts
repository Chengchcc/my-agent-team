import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { keyDispatcher } from "../input/key-dispatcher";
import fastGlob from "fast-glob";
import {
  type InputEditorState,
} from "../hooks/use-input-editor";
import { useInputHistory } from "../hooks/use-input-history";
import { getFoldedDisplay, hasPasteMarkers } from "../paste-attachments";

import {
  filterCommands,
  getSlashQuery,
  insertSlashCommand,
  getHighlightedCommandName,
} from '../../../application/slash';

import {
  getAtQuery,
  WELCOME_MESSAGES,
  AT_FILE_GLOB_DEPTH,
  MAX_AT_FILE_RESULTS,
  AT_FILE_DEBOUNCE_MS,
} from './tui-slash-utils';

import type { SlashCommand, PromptSubmission } from '../../../application/slash';
import {
  makeInputKeyHandler,
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

  // PR-3: inputKeyHandler will be wired via FALLTHROUGH KeyDispatcher layer
  void makeInputKeyHandler({
    onAbort, streaming, pickerOpen, slashQuery, setDismissedQuery,
    atFilePickerOpen, atQuery, atFiles, setDismissedAtQuery,
    isBrowsing, exitBrowsing, editorStateRef, setEditorState, updateEditorState,
    atSelectedIndex, setAtSelectedIndex, suppressEnterRef, commands, onSubmit,
    saveEntry, setFirstMessage, setSelectedIndex, hasMarkers,
    beginBrowsing, browseUp, browseDown,
  });

  return {
    filteredCommands, highlightedCommandName, pickerOpen,
    placeholder: firstMessage ? welcomeMessage : "Input anything to continue. Launch a new command or skill by typing `/`",
    selectedIndex, text: editorState.text, cursorOffset: editorState.cursorOffset,
    displayText, displayCursorOffset, pasteLineCount, atFiles, atSelectedIndex, atFilePickerOpen,
  };
}
