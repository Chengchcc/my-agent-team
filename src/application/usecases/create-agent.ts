import { AgentRecordCodec } from '../contracts/agent-record'
import type { AgentRecord, LarkAgentConfig } from '../contracts/agent-record'
import { createAgentPaths } from '../../infrastructure/paths/agent-paths'

const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/

export interface CreateAgentInput {
  agentId: string
  displayName: string
  identityMode: AgentRecord['identityMode']
  larkConfig?: LarkAgentConfig | null
  isDefault?: boolean
  now: number
  agentsRoot: string
}

export function createAgent(
  input: CreateAgentInput,
): { record: AgentRecord } {
  if (!AGENT_ID_RE.test(input.agentId)) {
    throw new Error(`agentId must match ^[a-z][a-z0-9-]{0,31}$`)
  }
  if (input.agentId === 'default') {
    throw new Error("'default' agent is reserved for automatic seeding")
  }

  const paths = createAgentPaths(input.agentsRoot, input.agentId)
  const identityStatus =
    input.identityMode === 'deferred' ? 'pending_bootstrap' : 'ready'

  const record = AgentRecordCodec.parse({
    agentId: input.agentId,
    displayName: input.displayName,
    createdAt: input.now,
    updatedAt: input.now,
    isDefault: input.isDefault ?? false,
    identityMode: input.identityMode,
    identityStatus,
    identityPath: paths.identity.file,
    bootstrapPath:
      input.identityMode === 'deferred' ? paths.identity.bootstrap : null,
    larkConfig: input.larkConfig ?? null,
    larkEnabled: input.larkConfig != null,
    larkLastTestAt: null,
    larkLastTestOk: null,
  })

  return { record }
}
