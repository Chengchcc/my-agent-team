import type { FlagSpec } from './parse'

/** Select which agent to target. */
export const FLAG_AGENT: FlagSpec = {
  name: 'agent',
  alias: 'a',
  type: 'string',
  default: 'default',
  description: 'Target agent ID',
}

/** Select which session to use. */
export const FLAG_SESSION: FlagSpec = {
  name: 'session',
  alias: 's',
  type: 'string',
  description: 'Session ID (default: main)',
}

/** Show debug details on error. */
export const FLAG_VERBOSE: FlagSpec = {
  name: 'verbose',
  alias: 'v',
  type: 'boolean',
  default: false,
  description: 'Show debug traces on error',
}

/** Output format for print command. */
export const FLAG_OUTPUT_FORMAT: FlagSpec = {
  name: 'output-format',
  type: 'string',
  default: 'text',
  description: 'Output format: text | json | stream-json',
}
