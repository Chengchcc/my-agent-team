import { z } from 'zod'
import { makeToolSchema } from './_factory'

const schema = z.object({
  todos: z.array(z.object({
    id: z.string().describe('Stable identifier for this todo item.'),
    content: z.string().min(1).describe('Task description in imperative form.'),
    status: z.enum(['pending', 'in_progress', 'completed', 'cancelled'])
      .describe('Current status. Exactly one item should be in_progress.'),
  })).describe('Full replacement list. Always send the complete current state, never a delta.'),
})

export type TodoWriteArgs = z.infer<typeof schema>
export const todoWriteToolSchema = makeToolSchema(schema)
