import { z } from 'zod'
import { makeToolSchema } from './_factory'

const schema = z.object({
  query: z.string().describe('Search query'),
})

export type WebSearchArgs = z.infer<typeof schema>
export const webSearchToolSchema = makeToolSchema(schema)
