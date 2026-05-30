import type React from 'react'
import { resolvePastePlaceholders } from '../paste-attachments'
import type { SlashCommand, PromptSubmission } from '../../../application/slash'
import { buildPromptSubmission as buildCore } from '../../../application/slash'
import type { InputEditorState } from '../hooks/use-input-editor'

export interface PickerState {
  filteredCommands: SlashCommand[];
  slashQuery: string | null;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  setDismissedQuery: React.Dispatch<React.SetStateAction<string | null>>;
  editorStateRef: React.MutableRefObject<InputEditorState>;
  acceptSelectedCommand: () => void;
  suppressEnterRef: React.MutableRefObject<boolean>;
}

export function buildPromptSubmissionTui(text: string, commands: SlashCommand[]): PromptSubmission {
  return buildCore(resolvePastePlaceholders(text), commands)
}

export function getAtQuery(text: string): { query: string; start: number } | null {
  const lastAt = text.lastIndexOf('@')
  if (lastAt === -1) return null
  if (lastAt > 0 && !/\s/.test(text[lastAt - 1]!)) return null
  const query = text.slice(lastAt + 1)
  if (query.includes(' ')) return null
  return { query, start: lastAt }
}

export const AT_FILE_GLOB_DEPTH = 10
export const MAX_AT_FILE_RESULTS = 15
export const AT_FILE_DEBOUNCE_MS = 120

export const WELCOME_MESSAGES = [
  'To the moon!',
  'What do you want to build today?',
  'Hey, there!',
  "What's on your mind?",
  'Build, build, build!',
  "What's your plan today?",
  'Dream, code, repeat!',
  'Your next idea goes here...',
]
