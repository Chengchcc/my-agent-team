import { z } from 'zod'
import { createCodec } from './shared/codec'

const schema = z.object({
  action: z.string(),
  session_id: z.string().optional(),
  card_nonce: z.string().optional(),
  root_id: z.string().optional(),
  question_index: z.string().optional(),
  selected_labels: z.string().optional(),
}).passthrough()

/** @public — consumed by card-handler via RPC payload */
export type LarkCardAction = z.infer<typeof schema>
export const larkCardActionCodec = createCodec(schema)
