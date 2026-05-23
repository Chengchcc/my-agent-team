import { z } from 'zod'
import { makeToolSchema } from './_factory'

const schema = z.object({
  command: z.enum(['view', 'create', 'str_replace', 'write']),
  path: z.string(),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  content: z.string().optional(),
  start_line: z.number().optional(),
  end_line: z.number().optional(),
})

export type TextEditorArgs = z.infer<typeof schema>
export const textEditorToolSchema = makeToolSchema(schema)
