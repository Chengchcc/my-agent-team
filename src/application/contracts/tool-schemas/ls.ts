import { z } from 'zod'
import { makeToolSchema } from './_factory'

const schema = z.object({
  path: z.string().default(process.cwd()).describe('Directory path to list (default: .)'),
  a: z.boolean().optional().describe('Show hidden files'),
})

export type LsArgs = z.infer<typeof schema>
export const lsToolSchema = makeToolSchema(schema)
