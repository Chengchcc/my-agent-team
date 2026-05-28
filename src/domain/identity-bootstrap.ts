export const REQUIRED_FIELDS = ['role', 'audience', 'tone', 'expertise', 'constraints'] as const
const TURNS_MAX = 6

export interface BootstrapState {
  status: 'pending' | 'archived'
  turnsCompleted: number
  turnsMax: number
  requiredFields: string[]
  collected: Record<string, string>
  stallCount: number
}

export function parseBootstrapFrontMatter(md: string): BootstrapState {
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) {
    return {
      status: 'pending',
      turnsCompleted: 0,
      turnsMax: TURNS_MAX,
      requiredFields: [...REQUIRED_FIELDS],
      collected: {},
      stallCount: 0,
    }
  }

  const fmText = fmMatch[1]
  if (!fmText) {
    return {
      status: 'pending',
      turnsCompleted: 0,
      turnsMax: TURNS_MAX,
      requiredFields: [...REQUIRED_FIELDS],
      collected: {},
      stallCount: 0,
    }
  }

  const fm: Record<string, unknown> = {}
  for (const line of fmText.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)/)
    if (m && m[1] !== undefined && m[2] !== undefined) {
      const key = m[1]
      const val = m[2].trim()
      if (val.startsWith('[')) {
        fm[key] = val
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/"/g, ''))
          .filter(Boolean)
      } else if (val.startsWith('{')) {
        try {
          fm[key] = JSON.parse(val)
        } catch {
          fm[key] = {}
        }
      } else {
        fm[key] = val
      }
    }
  }

  return {
    status: (fm.status as BootstrapState['status']) ?? 'pending',
    turnsCompleted: parseInt(String(fm.turns_completed ?? '0'), 10),
    turnsMax: parseInt(String(fm.turns_max ?? String(TURNS_MAX)), 10),
    requiredFields: (fm.required_fields as string[]) ?? [...REQUIRED_FIELDS],
    collected: (fm.collected as Record<string, string>) ?? {},
    stallCount: parseInt(String(fm.stall_count ?? '0'), 10),
  }
}


export function computeMissingFields(
  required: string[],
  collected: Record<string, string>,
): string[] {
  return required.filter((f) => !collected[f])
}

export function computeNextAction(
  state: BootstrapState,
): 'ask' | 'finalize' | 'force-finalize' {
  if (state.turnsCompleted >= state.turnsMax) return 'force-finalize'
  const missing = computeMissingFields(state.requiredFields, state.collected)
  if (missing.length === 0) return 'finalize'
  return 'ask'
}

export function renderBootstrapRequest(
  field: string,
  turnsCompleted?: number,
  turnsMax?: number,
): string {
  const fieldDescriptions: Record<string, string> = {
    role: '你的角色定位（例如：后端工程师、产品经理、研究员）',
    audience: '你的目标用户群体（例如：全栈开发者、运营团队、外部客户）',
    tone: '你希望我用什么语气（例如：简洁专业、友好幽默、严谨学术）',
    expertise: '你需要我擅长哪些领域（例如：TypeScript+分布式、品牌营销、数据分析）',
    constraints: '有什么约束或禁区（例如：不写代码注释、不主动建议、必须中文回复）',
  }
  const hint = fieldDescriptions[field] ?? field
  const remain = turnsCompleted !== undefined && turnsMax !== undefined
    ? `第 ${turnsCompleted + 1}/${turnsMax} 轮`
    : ''

  return `## Bootstrap Pending — 身份初始化${remain}

**[最高优先级,本轮唯一任务]**
用一句简短中文向用户提问：${hint}

绝对禁止：
- 输出字段名（如"role"、"audience"等英文）
- 寒暄、自我介绍、复述用户上一条消息
- 调用任何工具
- 回答用户的其他话题
- 假装 bootstrap 已完成

只输出一句问句,不要其他任何内容。`
}

export const DEFAULT_BOOTSTRAP_MD = `---
status: pending
turns_completed: 0
turns_max: 6
stall_count: 0
required_fields: ["role","audience","tone","expertise","constraints"]
collected: {}
---`

// Agent Identity Bootstrap — code-driven state machine; LLM only outputs one question per turn.
