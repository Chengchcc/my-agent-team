import type { Prompts } from '../prompts/prompt-runner'
import chalk from 'chalk'
import { initIdentity } from '../../application/usecases/init-identity'
import type { ProviderInvoke } from '../../application/ports/provider'

export type IdentityMode = 'questionnaire' | 'llm_oneshot' | 'deferred'

const QUESTIONS = [
  { key: 'role', label: '角色定位（如：Engineering Assistant）', required: true },
  { key: 'audience', label: '目标用户（团队 / 个人）', required: true },
  { key: 'tone', label: '语气（concise / formal / friendly...）', default: 'concise, helpful' },
  { key: 'expertise', label: 'Top-3 领域专长（逗号分隔）', required: true },
  { key: 'constraints', label: '硬约束 / 拒绝规则（每行一条，空行结束）', multiline: true },
  { key: 'success', label: '什么样的回答算"好"？', required: false },
]

export interface IdentityFlowResult {
  identityMd: string
  bootstrapMd: string | null
  mode: IdentityMode
}

const MAX_REFINEMENT_ATTEMPTS = 3
const PREVIEW_CHAR_LIMIT = 500

export async function runIdentityFlow(
  prompts: Prompts,
  mode: IdentityMode,
  deps: {
    provider?: ProviderInvoke
    defaults?: Record<string, string>
    descriptionPrefill?: string
  },
): Promise<IdentityFlowResult> {
  switch (mode) {
    case 'questionnaire': {
      const answers: Record<string, string> = {}
      for (const q of QUESTIONS) {
        const defaultVal = deps.defaults?.[q.key] ?? q.default ?? ''
        const val = await prompts.text({
          message: `${q.label}:`,
          defaultValue: defaultVal,
          validate: q.required ? (v) => v?.trim() ? undefined : 'Required' : undefined,
        })
        answers[q.key] = val
      }
      const result = await initIdentity({ mode: 'questionnaire', answers }, '')
      return { ...result, mode }
    }

    case 'llm_oneshot': {
      if (!deps.provider) {
        throw new Error('Provider is required for llm_oneshot mode')
      }
      let description = await prompts.text({
        message: '用一段话描述你想要的 agent：',
        defaultValue: deps.descriptionPrefill ?? '',
      })

      for (let attempt = 0; attempt < MAX_REFINEMENT_ATTEMPTS; attempt++) {
        try {
          const result = await initIdentity(
            { mode: 'llm_oneshot', description, provider: deps.provider },
            `agent-create-${Date.now()}`,
          )
          // Show preview
          const preview = result.identityMd.slice(0, PREVIEW_CHAR_LIMIT)
          console.log(chalk.dim(preview))
          const ok = await prompts.confirm({ message: '保存这份身份？' })
          if (ok) return { ...result, mode }

          if (attempt < MAX_REFINEMENT_ATTEMPTS - 1) {
            const hint = await prompts.text({ message: '简述需要修改的地方：' })
            description = description + '\n\n调整需求：' + hint
          }
        } catch (err) {
          if (attempt >= MAX_REFINEMENT_ATTEMPTS - 1) throw err
          console.log(chalk.yellow(`生成失败：${String(err)}，重试...`))
        }
      }
      throw new Error('Exceeded max refinement attempts')
    }

    case 'deferred': {
      const result = await initIdentity({ mode: 'deferred' }, '')
      return { ...result, mode }
    }
  }
}
