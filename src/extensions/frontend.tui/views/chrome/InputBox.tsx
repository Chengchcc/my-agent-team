import React from 'react';
import { Box, Text } from 'ink';
import { useCommandInput } from '../../slash/use-slash-input';
import { useBracketedPaste } from '../../hooks/use-bracketed-paste';
import { HighlightedInput } from '../../components/HighlightedInput';
import { SlashCommandList } from '../../slash/components/slash-command-list';
import { FilePicker } from '../../components/file-picker-popover';
import type { PromptSubmission, SlashCommand } from '../../../../application/slash';
import { useTuiStore } from '../../state/store';
import { INPUT_PREFIXES } from '../../input/input-prefixes';

interface InputBoxProps {
  commands: SlashCommand[];
  onSubmit: (submission: PromptSubmission) => void;
  onAbort?: () => void;
}

const PENDING_PREVIEW_MAX = 120;
const PENDING_TRUNC = 117;

export function InputBox({ commands, onSubmit, onAbort }: InputBoxProps) {
  useBracketedPaste();
  const streaming = useTuiStore(s => s.stats.streaming);
  const pendingInputs = useTuiStore(s => s.interaction.pendingInputs);

  const commandInputOpts = { commands, streaming, onSubmit };
  const {
    filteredCommands,
    highlightedCommandName,
    pickerOpen,
    placeholder,
    selectedIndex,
    displayText,
    displayCursorOffset,
    pasteLineCount,
    atFiles,
    atSelectedIndex,
    atFilePickerOpen,
  } = useCommandInput(
    onAbort ? { ...commandInputOpts, onAbort } : commandInputOpts,
  );

  // Key input now routed through App-level single useInput → keyDispatcher
  // INPUT_EDIT + FALLTHROUGH layers registered in PR-3 (K-1)

  return (
    <Box flexDirection="column">
      {pickerOpen ? <SlashCommandList commands={filteredCommands} selectedIndex={selectedIndex} /> : null}
      {atFilePickerOpen ? (
        atFiles.length > 0
          ? <FilePicker files={atFiles} selectedIndex={atSelectedIndex} />
          : <Box paddingX={2}><Text dimColor>  searching files…</Text></Box>
      ) : null}

      {!pickerOpen && !atFilePickerOpen && !displayText ? (
        <Box paddingX={2}>
          <Text dimColor>
            {INPUT_PREFIXES.map(p => p.shortLabel).join('  ·  ')}
            {'  ·  ↑ for history'}
          </Text>
        </Box>
      ) : null}

      {pendingInputs.length === 1 ? (
        <Box paddingX={2}>
          <Text color="yellow">[queued] </Text>
          <Text dimColor>{pendingInputs[0]!.length > PENDING_PREVIEW_MAX ? pendingInputs[0]!.slice(0, PENDING_TRUNC) + '…' : pendingInputs[0]}</Text>
          <Text dimColor> · Ctrl+K to clear</Text>
        </Box>
      ) : pendingInputs.length > 1 ? (
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

      {pasteLineCount > 0 ? (
        <Box paddingX={2}>
          <Text dimColor>[paste] folded ({pasteLineCount} lines) · ? for help</Text>
        </Box>
      ) : null}

      <Box borderStyle="round" borderColor={streaming ? 'gray' : pendingInputs.length > 0 ? 'yellow' : 'cyan'} paddingX={1}>
        <Text color="cyan">{'>'} </Text>
        <HighlightedInput
          value={displayText}
          cursorOffset={displayCursorOffset}
          placeholder={streaming ? '(replying… Esc to interrupt, Enter to queue)' : placeholder}
          highlightedCommandName={highlightedCommandName}
        />
      </Box>
    </Box>
  );
}
