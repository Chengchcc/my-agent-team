import { z } from 'zod'
import { makeToolSchema } from './_factory'

const schema = z.object({
  url: z.string().describe('URL to fetch'),
  prompt: z.string().optional().describe('Optional prompt to process fetched content'),
})

export type WebFetchArgs = z.infer<typeof schema>
export const webFetchToolSchema = makeToolSchema(schema)
