import { z } from 'zod'

const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/

export const LarkAgentConfigCodec = z.object({
  appId: z.string().min(1),
  appSecretEnv: z.string().min(1),
})

export const AgentRecordCodec = z.object({
  agentId: z.string().regex(AGENT_ID_RE, 'agentId must be lowercase slug: ^[a-z][a-z0-9-]{0,31}$'),
  displayName: z.string().min(1),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  isDefault: z.boolean(),
  identityMode: z.enum(['questionnaire', 'llm_oneshot', 'deferred']),
  identityStatus: z.enum(['ready', 'pending_bootstrap']),
  identityPath: z.string().min(1),
  bootstrapPath: z.string().nullable(),
  larkConfig: LarkAgentConfigCodec.nullable(),
  larkEnabled: z.boolean(),
  larkLastTestAt: z.number().int().positive().nullable(),
  larkLastTestOk: z.union([z.literal(0), z.literal(1)]).nullable(),
})

export type AgentRecord = z.infer<typeof AgentRecordCodec>
export type LarkAgentConfig = z.infer<typeof LarkAgentConfigCodec>
