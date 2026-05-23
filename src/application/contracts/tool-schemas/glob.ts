import { z } from 'zod'
import { makeToolSchema } from './_factory'

const schema = z.object({
  pattern: z.string().describe('Glob pattern (e.g. **/*.ts)'),
  path: z.string().default(process.cwd()).describe('Base directory (default: .)'),
})

export type GlobArgs = z.infer<typeof schema>
export const globToolSchema = makeToolSchema(schema)
