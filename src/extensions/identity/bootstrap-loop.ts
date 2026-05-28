import type { FileBackedIdentityStore } from '../../infrastructure/identity/file-backed-identity-store'
import type { AgentRegistryRead } from '../../application/ports/agent-registry'
import type { AgentStore } from '../../application/ports/agent-store'
import type { ProviderInvoke } from '../../application/ports/provider'
import type { Logger } from '../../application/ports/logger'
import crypto from 'crypto'
import {
  parseBootstrapFrontMatter,
  computeMissingFields,
  computeNextAction,
  renderBootstrapRequest,
  REQUIRED_FIELDS,
} from '../../domain/identity-bootstrap'
import { renderIdentityMd } from '../../domain/identity-doc'
import { atomicWrite, atomicRead } from '../../shared/atomic-write'
import { readFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
export interface BootstrapLoopDeps {
  store: FileBackedIdentityStore
  registry: AgentRegistryRead
  provider: ProviderInvoke
  logger: Logger
  bootstrapPath: string
  archivedPath: string
  /** Used to flip identityStatus pending_bootstrap → ready after finalize. */
  agentStore: AgentStore
  agentId: string
}

export function createBootstrapLoop(deps: BootstrapLoopDeps) {
  return {
    injectRequest(prompt: { system: string; messages: Array<{ role: string; content: string }> }): typeof prompt {
      const state = loadBootstrapState(deps.bootstrapPath)
      computeNextAction(state) // check action but let field selection drive prompt
      const missing = computeMissingFields(state.requiredFields, state.collected)
      const field = missing.length > 0 ? missing[0]! : state.requiredFields[0]!
      prompt.system = `${prompt.system}\n${renderBootstrapRequest(field, state.turnsCompleted, state.turnsMax)}`
      return prompt
    },

    /**
     * BOOTSTRAP override — fully replace prompt.system with bootstrap-only content,
     * discarding anything appended by upstream transformPrompt hooks
     * (tools, session-mode, ...). Also trims messages to the last user turn
     * to prevent historical-context bleed.
     */
    buildOverridePrompt(
      prompt: { system: string; messages: Array<{ role: string; content: string }> },
    ): typeof prompt {
      const state = loadBootstrapState(deps.bootstrapPath)
      computeNextAction(state)
      const missing = computeMissingFields(state.requiredFields, state.collected)
      const field = missing.length > 0 ? missing[0]! : state.requiredFields[0]!
      const lastUser = [...prompt.messages].reverse().find(m => m.role === 'user')
      return {
        system: renderBootstrapRequest(field, state.turnsCompleted, state.turnsMax),
        messages: lastUser ? [lastUser] : [],
      }
    },

    async handleTurnEnd(payload: { userMessage?: { role: string; content: string } }): Promise<void> {
      const state = loadBootstrapState(deps.bootstrapPath)
      const lastUserMsg = payload.userMessage
      if (!lastUserMsg?.content) return

      try {
        const extractRes = await deps.provider.call({
          kind: 'internal',
          purpose: 'identity.bootstrap.extract',
          parentTurnId: `bootstrap-${crypto.randomUUID()}`,
          messages: [
            { role: 'system', content: `Extract identity fields from the user's response. Return ONLY a JSON object with the fields the user provided values for. Do NOT return markdown, code blocks, or explanatory text.

Fields to watch for: ${state.requiredFields.filter(f => !state.collected[f]).join(', ')}

Examples:
User: "我是后端工程师"
→ {"role":"后端工程师"}

User: "团队主要是全栈开发者，用 TypeScript"
→ {"audience":"全栈开发者","expertise":"TypeScript"}

User: "你好啊"
→ {}

Return ONLY the JSON object.` },
            { role: 'user', content: lastUserMsg.content },
          ],
          maxTokens: 200,
        })

        const patch = parseBootstrapPatch(extractRes.content)
        if (patch && Object.keys(patch).length > 0) {
          Object.assign(state.collected, patch)
          state.turnsCompleted += 1
        } else {
          state.turnsCompleted += 1
        }
      } catch (err) {
        deps.logger.warn('bootstrap', `extract failed: ${String(err)}`)
        return
      }

      const action = computeNextAction(state)

      if (action === 'finalize' || action === 'force-finalize') {
        // Synthesize final identity
        try {
          const synthRes = await deps.provider.call({
            kind: 'internal',
            purpose: 'identity.synthesize',
            parentTurnId: `bootstrap-final-${crypto.randomUUID()}`,
            messages: [
              { role: 'system', content: `Generate an identity markdown document from these collected fields. Include YAML front-matter with: role, audience, tone, expertise. The user provided: ${JSON.stringify(state.collected)}` },
              { role: 'user', content: 'Generate the identity document.' },
            ],
            maxTokens: 800,
          })

          const cleaned = synthRes.content.trim()
          const fm = cleaned.match(/^---\n([\s\S]*?)\n---/)

          const fields: Record<string, string> = { ...state.collected }
          if (fm && fm[1]) {
            for (const line of fm[1].split('\n')) {
              const m = line.match(/^(\w+):\s*(.+)/)
              if (m && m[1] && m[2]) fields[m[1]] = m[2].trim()
            }
          }

          const body = cleaned.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
          await deps.store.update({ fields, body }, { source: 'bootstrap' })

          // Archive bootstrap.md
          try {
            const content = await atomicRead(deps.bootstrapPath, '')
            if (content) {
              await atomicWrite(deps.archivedPath, content)
            }
          } catch { /* best effort */ }
          try { await unlink(deps.bootstrapPath) } catch { /* best effort */ }

          state.status = 'archived'

          // Promote AgentRecord.identityStatus to 'ready' — best-effort, never throw.
          try {
            await deps.agentStore.update(deps.agentId, { identityStatus: 'ready' })
            deps.logger.info('bootstrap', `agent ${deps.agentId} identityStatus → ready`)
          } catch (err) {
            deps.logger.warn(
              'bootstrap',
              `failed to promote identityStatus to ready: ${String(err)} (bootstrap files archived but transformPrompt will keep using bootstrap branch until next restart)`,
            )
          }
        } catch (err) {
          deps.logger.error('bootstrap', `final synthesis failed: ${String(err)}`)
        }
      } else {
        // Still in progress: save updated bootstrap.md and draft identity.md
        const md = `---
status: pending
turns_completed: ${state.turnsCompleted}
turns_max: ${state.turnsMax}
required_fields: ${JSON.stringify(state.requiredFields)}
collected: ${JSON.stringify(state.collected)}
---

# Agent Identity Bootstrap
`
        try {
          await atomicWrite(deps.bootstrapPath, md)
          // Write draft identity.md
          const draftPath = deps.store.getDraftPath()
          if (!draftPath) throw new Error('identity draft path is empty')
          const draftMd = renderIdentityMd(state.collected, '# Identity (draft)')
          await atomicWrite(draftPath, draftMd)
        } catch (err) {
          deps.logger.warn('bootstrap', `file write failed: ${String(err)}`)
        }
      }
    },
  }
}

function loadBootstrapState(bootstrapPath: string) {
  try {
    const content = readFileSync(bootstrapPath, 'utf-8')
    return parseBootstrapFrontMatter(content)
  } catch {
    return {
      status: 'pending' as const,
      turnsCompleted: 0,
      turnsMax: 6,
      requiredFields: [...REQUIRED_FIELDS],
      collected: {},
    }
  }
}

function parseBootstrapPatch(text: string): Record<string, string> | null {
  try {
    const trimmed = text.trim()

    // Try extracting JSON from markdown code blocks first
    const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/)
    const candidate = codeBlock ? codeBlock[1]!.trim() : trimmed

    if (candidate.startsWith('{')) {
      const parsed = JSON.parse(candidate)
      const result: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') result[k] = v
      }
      return Object.keys(result).length > 0 ? result : null
    }
    // Try key:value lines
    const lines = candidate.split('\n')
    const result: Record<string, string> = {}
    for (const line of lines) {
      const m = line.match(/^"?(\w+)"?\s*:\s*"?(.+?)"?$/)
      if (m && m[1] && m[2]) result[m[1]] = m[2]
    }
    return Object.keys(result).length > 0 ? result : null
  } catch {
    return null
  }
}
