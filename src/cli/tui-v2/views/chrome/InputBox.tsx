import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useCommandInput } from '../../../tui/hooks/use-command-input';
import { useBracketedPaste } from '../../../tui/hooks/use-bracketed-paste';
import { HighlightedInput } from '../../../tui/components/HighlightedInput';
import { CommandList } from '../../../tui/components/CommandList';
import { FilePicker } from '../../../tui/components/FilePicker';
import type { PromptSubmission, SlashCommand } from '../../../tui/command-registry';
import {
  useInteractionSelector,
  useStatsSelector,
} from '../../state/selectors';
import { buildHotkeys } from './keymap';
import type { InputBoxCallbacks } from './keymap';

export type { InputBoxCallbacks } from './keymap';

interface InputBoxProps {
  commands: SlashCommand[];
  onSubmit: (submission: PromptSubmission) => void;
  onAbort?: () => void;
  callbacks: InputBoxCallbacks;
}

const PENDING_PREVIEW_MAX = 120;
const PENDING_TRUNC = 117;

export function InputBox({ commands, onSubmit, onAbort, callbacks }: InputBoxProps) {
  useBracketedPaste();
  const streaming = useStatsSelector(s => s.streaming);
  const pendingInputs = useInteractionSelector(s => s.pendingInputs);
  const focusedToolId = useInteractionSelector(s => s.focusedToolId);

  const commandInputOpts = { commands, streaming, onSubmit };
  const {
    filteredCommands,
    highlightedCommandName,
    pickerOpen,
    placeholder,
    selectedIndex,
    displayText,
    displayCursorOffset,
    atFiles,
    atSelectedIndex,
    atFilePickerOpen,
  } = useCommandInput(
    onAbort ? { ...commandInputOpts, onAbort } : commandInputOpts,
  );

  const hotkeys = useMemo(() => buildHotkeys(callbacks), [callbacks]);

  useInput((input, key) => {
    for (const hk of hotkeys) {
      if (hk.guard && !hk.guard({ streaming, pendingCount: pendingInputs.length, focusedToolId })) continue;
      if (input === hk.key) {
        // Escape key is special — check key.escape instead of input match
        if (hk.key === 'escape' && !key.escape) continue;
        // Ctrl key
        if (hk.ctrl && !key.ctrl) continue;
        // Meta key
        if (hk.meta && !key.meta) continue;
        // Shift key
        if (hk.shift && !key.shift) continue;
        // Space — only match literal space, not any whitespace
        if (hk.key === ' ' && input !== ' ') continue;
        hk.handler();
        return;
      }
    }
  });

  return (
    <Box flexDirection="column">
      {pickerOpen ? <CommandList commands={filteredCommands} selectedIndex={selectedIndex} /> : null}
      {atFilePickerOpen ? <FilePicker files={atFiles} selectedIndex={atSelectedIndex} /> : null}

      {pendingInputs.length > 0 ? (
        <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
          <Box>
            <Text color="yellow" bold>Pending ({pendingInputs.length})</Text>
            {streaming ? <Text dimColor> — waiting for current turn</Text> : null}
          </Box>
          {pendingInputs.map((text, i) => (
            <Box key={i}>
              <Text dimColor>{i + 1}. </Text>
              <Text>
                {text.length > PENDING_PREVIEW_MAX ? text.slice(0, PENDING_TRUNC) + '…' : text}
              </Text>
            </Box>
          ))}
          <Box>
            <Text dimColor>Ctrl+K to clear</Text>
          </Box>
        </Box>
      ) : null}

      {focusedToolId ? (
        <Box>
          <Text dimColor>focus: {focusedToolId}</Text>
        </Box>
      ) : null}

      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text color="cyan">{'>'} </Text>
        <HighlightedInput
          value={displayText}
          cursorOffset={displayCursorOffset}
          placeholder={placeholder}
          highlightedCommandName={highlightedCommandName}
        />
      </Box>
    </Box>
  );
}
