import { z } from 'zod'
import { makeToolSchema } from './_factory'

const schema = z.object({
  path: z.string().describe('Absolute or relative file path to edit'),
  old_string: z.string().describe('Exact substring to find (must match exactly once)'),
  new_string: z.string().describe('Replacement string'),
})

export type EditArgs = z.infer<typeof schema>
export const editToolSchema = makeToolSchema(schema)
