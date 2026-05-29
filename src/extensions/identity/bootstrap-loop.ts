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
import type { BootstrapState } from '../../domain/identity-bootstrap'
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
     * BOOTSTRAP supplement — append bootstrap section to the existing system prompt,
     * preserving upstream transformPrompt contributions (identity, memory, etc.).
     * No longer replaces the entire prompt; tool gating is handled in run-turn.ts.
     */
    async buildBootstrapSupplement(
      prompt: { system: string; messages: Array<{ role: string; content: string }> },
      mode: 'full' | 'limited',
    ): Promise<typeof prompt> {
      const state = loadBootstrapState(deps.bootstrapPath)
      computeNextAction(state)
      const missing = computeMissingFields(state.requiredFields, state.collected)
      const field = missing.length > 0 ? missing[0]! : state.requiredFields[0]!

      // Persist initial state so preTurnAbsorb can find the file on next turn
      if (state.turnsCompleted === 0 && Object.keys(state.collected).length === 0) {
        await persistBootstrapState(deps, state)
      }

      let supplement = renderBootstrapRequest(field, state.turnsCompleted, state.turnsMax)
      if (mode === 'limited') {
        supplement = `## Bootstrap Pending — 身份初始化（受限模式）

当前运行环境不能安全完成完整 bootstrap，只能继续收集缺失字段或告知下一步。
请用一句简短中文询问当前缺失字段。
不要假装 bootstrap 已完成。`
      }

      // Bootstrap 放最前面：LLM 对开头权重最高，同时剥离会引发角色冲突的 baseline 行
      const cleaned = prompt.system.replace(/^(?:You are a helpful AI assistant\.?\s*|Follow the user's instructions\.?\s*)/i, '')
      return { ...prompt, system: `${supplement}\n\n---\n\n${cleaned}` }
    },

    /**
     * Absorb user response BEFORE building the supplement.
     * Moves state advancement from turn-end (lagging one turn) to turn-start (real-time).
     * Called from buildBootstrapSupplement, which runs inside transformPrompt.
     */
    async preTurnAbsorb(payload: { userMessage?: { role: string; content: string } }): Promise<void> {
      const state = loadBootstrapState(deps.bootstrapPath)
      if (state.status === 'archived') return
      const userContent = payload.userMessage?.content
      if (!userContent) return

      // Skip extract on first turn only if bootstrap state file was never persisted.
      // Once buildBootstrapSupplement writes the initial state, subsequent turns will find
      // the file on disk and proceed with extraction (even if turnsCompleted is still 0).
      try { readFileSync(deps.bootstrapPath, 'utf-8') } catch { return }

      // 1. Extract fields from user's answer to the PREVIOUS question
      try {
        const patch = await extractWithLLM(deps.provider, state, userContent)
        if (patch && Object.keys(patch).length > 0) {
          Object.assign(state.collected, patch)
          state.turnsCompleted += 1
          state.stallCount = 0
        } else {
          state.stallCount = (state.stallCount ?? 0) + 1
          if (state.stallCount >= 2) {
            state.turnsCompleted += 1
            state.stallCount = 0
          }
        }
      } catch (err) {
        deps.logger.warn('bootstrap', `extract failed: ${String(err)}`)
        return
      }

      // 2. If all collected or maxed out, finalize NOW (before injectRequest runs)
      const action = computeNextAction(state)
      if (action !== 'ask') {
        await finalizeBootstrap(deps, state)
        return
      }

      // 3. Persist updated state so supplement sees fresh collected
      await persistBootstrapState(deps, state)
    },

    async handleTurnEnd(_payload: { userMessage?: { role: string; content: string } }): Promise<void> {
      // State advancement moved to preTurnAbsorb; nothing to do here.
    },
  }
}

async function extractWithLLM(
  provider: ProviderInvoke,
  state: Pick<BootstrapState, 'requiredFields' | 'collected'>,
  userContent: string,
): Promise<Record<string, string> | null> {
  const extractRes = await provider.call({
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
      { role: 'user', content: userContent },
    ],
    maxTokens: 200,
  })
  return parseBootstrapPatch(extractRes.content)
}

async function finalizeBootstrap(
  deps: BootstrapLoopDeps,
  state: BootstrapState,
): Promise<void> {
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

    // Promote AgentRecord.identityStatus to 'ready'
    try {
      await deps.agentStore.update(deps.agentId, { identityStatus: 'ready' })
      deps.logger.info('bootstrap', `agent ${deps.agentId} identityStatus → ready`)
    } catch (err) {
      deps.logger.warn(
        'bootstrap',
        `failed to promote identityStatus to ready: ${String(err)}`,
      )
    }
  } catch (err) {
    deps.logger.error('bootstrap', `final synthesis failed: ${String(err)}`)
  }
}

async function persistBootstrapState(
  deps: BootstrapLoopDeps,
  state: BootstrapState,
): Promise<void> {
  const md = `---
status: pending
turns_completed: ${state.turnsCompleted}
turns_max: ${state.turnsMax}
required_fields: ${JSON.stringify(state.requiredFields)}
collected: ${JSON.stringify(state.collected)}
stall_count: ${state.stallCount}
---

# Agent Identity Bootstrap
`
  try {
    await atomicWrite(deps.bootstrapPath, md)
    const draftPath = deps.store.getDraftPath()
    if (draftPath) {
      const draftMd = renderIdentityMd(state.collected, '# Identity (draft)')
      await atomicWrite(draftPath, draftMd)
    }
  } catch (err) {
    deps.logger.warn('bootstrap', `file write failed: ${String(err)}`)
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
      stallCount: 0,
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
