import { z } from 'zod'
import { makeToolSchema } from './_factory'

const schema = z.object({
  path: z.string().describe('Absolute or relative file path to write'),
  content: z.string().describe('Full file content'),
  overwrite: z.boolean().default(false).describe('Allow overwriting existing files'),
})

export type WriteArgs = z.infer<typeof schema>
export const writeToolSchema = makeToolSchema(schema)
