import { z } from 'zod'
import { makeToolSchema } from './_factory'

const schema = z.object({
  command: z.string().describe('The shell command to execute.'),
  cwd: z.string().optional().describe('Working directory for the command (optional).'),
})

export type BashArgs = z.infer<typeof schema>
export const bashToolSchema = makeToolSchema(schema)
