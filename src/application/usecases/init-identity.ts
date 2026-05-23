import type { ProviderInvoke } from '../ports/provider'
import { renderIdentityMd } from '../../domain/identity-doc'
import { DEFAULT_BOOTSTRAP_MD } from '../../domain/identity-bootstrap'

export interface InitIdentityInputM1 {
  mode: 'questionnaire'
  answers: Record<string, string>
}
export interface InitIdentityInputM2 {
  mode: 'llm_oneshot'
  description: string
  provider: ProviderInvoke
  refineHint?: string
}
export interface InitIdentityInputM3 {
  mode: 'deferred'
}
export type InitIdentityInput =
  | InitIdentityInputM1
  | InitIdentityInputM2
  | InitIdentityInputM3

export interface InitIdentityOutput {
  identityMd: string
  bootstrapMd: string | null
}

export const IDENTITY_SYNTHESIS_PROMPT = `You are an identity synthesizer. Generate a markdown identity document for an AI agent.

OUTPUT FORMAT:
- Must start with YAML front-matter containing: role, audience, tone, expertise
- Followed by markdown body describing the agent's purpose and behavior
- Do NOT wrap the response in code fences
- Do NOT include any text before the front-matter or after the body

Example:
---
role: Engineering Assistant
audience: 后端团队
tone: concise, helpful
expertise: TypeScript, distributed systems
---

# Identity

You are an Engineering Assistant for the backend team.`

function renderIdentityFromAnswers(
  answers: Record<string, string>,
): { identityMd: string; bootstrapMd: null } {
  const fields: Record<string, string> = {}
  if (answers.role) fields.role = answers.role
  if (answers.audience) fields.audience = answers.audience
  if (answers.tone) fields.tone = answers.tone
  if (answers.expertise) fields.expertise = answers.expertise

  const constraints = answers.constraints ?? ''
  const body = `# Identity\n\nYou are ${answers.role ?? 'an AI assistant'} for ${answers.audience ?? 'users'}.\n\n## Constraints\n${constraints}`
  return { identityMd: renderIdentityMd(fields, body), bootstrapMd: null }
}

function stripCodeFence(text: string): string {
  let result = text.trim()
  if (result.startsWith('```')) {
    result = result
      .replace(/^```[a-z]*\n?/, '')
      .replace(/\n?```$/, '')
  }
  return result.trim()
}

export async function initIdentity(
  input: InitIdentityInput,
  parentTurnId: string,
): Promise<InitIdentityOutput> {
  switch (input.mode) {
    case 'questionnaire':
      return renderIdentityFromAnswers(input.answers)

    case 'llm_oneshot': {
      const desc =
        input.description +
        (input.refineHint ? `\n\n调整需求：${input.refineHint}` : '')
      const res = await input.provider.call({
        kind: 'internal',
        purpose: 'identity.synthesize',
        parentTurnId,
        messages: [
          { role: 'system', content: IDENTITY_SYNTHESIS_PROMPT },
          { role: 'user', content: desc },
        ],
        maxTokens: 800,
      })
      const cleaned = stripCodeFence(res.content)
      const fmBody = cleaned.match(/^---\n([\s\S]*?)\n---/)?.[1]
      const hasRole = fmBody?.includes('role:') ?? false
      const hasAudience = fmBody?.includes('audience:') ?? false
      const hasTone = fmBody?.includes('tone:') ?? false
      const hasExpertise = fmBody?.includes('expertise:') ?? false
      if (!hasRole || !hasAudience || !hasTone || !hasExpertise) {
        throw new Error(
          'Synthesized identity missing required front-matter fields',
        )
      }
      return { identityMd: cleaned, bootstrapMd: null }
    }

    case 'deferred': {
      const placeholderMd = `---
role: TBD
status: pending_bootstrap
---
# Identity (pending)
This identity will be filled in by the agent during the first conversations.
`
      return { identityMd: placeholderMd, bootstrapMd: DEFAULT_BOOTSTRAP_MD }
    }
  }
}
