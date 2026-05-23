import { z } from 'zod'
import { makeToolSchema } from './_factory'

const DEFAULT_READ_MAX_LINES = 500

const schema = z.object({
  path: z.string().describe('File path to read'),
  start_line: z.number().int().positive().default(1).describe('Starting line number (1-indexed)'),
  end_line: z.number().int().positive().optional().describe('Ending line number (inclusive)'),
  max_lines: z.number().int().positive().default(DEFAULT_READ_MAX_LINES).describe('Maximum lines to return'),
  encoding: z.enum(['utf8', 'ascii', 'utf16le', 'ucs2', 'base64', 'latin1', 'binary', 'hex']).default('utf8').describe('File encoding'),
})

export type ReadArgs = z.infer<typeof schema>
export const readToolSchema = makeToolSchema(schema)
