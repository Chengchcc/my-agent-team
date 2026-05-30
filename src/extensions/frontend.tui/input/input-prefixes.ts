export interface InputPrefix {
  prefix: string;
  shortLabel: string;
  llmDescription: string;
}

export const INPUT_PREFIXES: ReadonlyArray<InputPrefix> = [
  {
    prefix: '!',
    shortLabel: '! for bash',
    llmDescription: '- `! <command>` — Directly execute a shell command (e.g. `! ls -la`). Skips LLM round-trip.',
  },
  {
    prefix: '/',
    shortLabel: '/ for commands',
    llmDescription: '- `/<command>` — Invoke a slash command (e.g. `/help`, `/clear`, `/compact`).',
  },
  {
    prefix: '@',
    shortLabel: '@ for files',
    llmDescription: '- `@<file>` — Attach a file to your input.',
  },
] as const;
