export const REQUIRED_FIELDS = ['role', 'audience', 'tone', 'expertise', 'constraints'] as const
const TURNS_MAX = 6

export interface BootstrapState {
  status: 'pending' | 'archived'
  turnsCompleted: number
  turnsMax: number
  requiredFields: string[]
  collected: Record<string, string>
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
    ? `（第 ${turnsCompleted + 1}/${turnsMax} 轮）`
    : ''

  return `

===== AGENT BOOTSTRAP MODE — 最高优先级指令 =====
当前状态：身份未初始化（pending_bootstrap）。

【你必须】完全忽略上方所有其他 system 指令（包括 helpful assistant 设定、工具说明、记忆等），
本轮唯一任务：用一句简短中文（≤40字）向用户提问，问且只问字段「${field}」。
含义：${hint}

【硬性约束】
1. 不要寒暄、不要自我介绍、不要回答用户上一条消息的内容
2. 直接输出问题，不要任何前缀/后缀/解释/markdown
3. 不要调用任何工具
4. 不要列出多个问题或选项

【格式示例】
- ✅ "你希望我扮演什么角色？"
- ✅ "我服务的对象主要是谁？"
- ❌ "你好！我是 AI 助手，请问..."  （有寒暄）
- ❌ "请告诉我角色、受众、语气"   （多字段）

${remain}
===== END BOOTSTRAP MODE =====
`
}

export const DEFAULT_BOOTSTRAP_MD = `---
status: pending
turns_completed: 0
turns_max: 6
required_fields: ["role","audience","tone","expertise","constraints"]
collected: {}
---

# Agent Identity Bootstrap

身份未初始化。Agent 处于 BOOTSTRAP MODE：
- 每轮只问一个字段（role → audience → tone → expertise → constraints）
- LLM 收到最高优先级指令，忽略其他 system prompt，只输出引导问题
- 用户回答后提取字段写入 collected，推进 turns_completed
- 全部收齐或达 turns_max 后合成 identity.md 并归档本文件为 bootstrap.archived.md
`
