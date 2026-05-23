import { z } from 'zod'
import { makeToolSchema } from './_factory'

const schema = z.object({
  pattern: z.string().describe('Text or regex pattern to search for'),
  path: z.string().default(process.cwd()).describe('Base directory to search from'),
  glob: z.string().optional().describe('Glob pattern to filter files'),
})

export type GrepArgs = z.infer<typeof schema>
export const grepToolSchema = makeToolSchema(schema)
