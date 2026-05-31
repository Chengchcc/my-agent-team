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

export const FIELD_HINTS: Record<string, string> = {
  role: '你的角色定位（例如：后端工程师、产品经理、研究员）',
  audience: '你的目标用户群体（例如：全栈开发者、运营团队、外部客户）',
  tone: '你希望我用什么语气（例如：简洁专业、友好幽默、严谨学术）',
  expertise: '你需要我擅长哪些领域（例如：TypeScript+分布式、品牌营销、数据分析）',
  constraints: '有什么约束或禁区（例如：不写代码注释、不主动建议、必须中文回复）',
}

export function renderProgressTag(turn: number, max: number): string {
  return `_(${turn}/${max} · 输入 \`/bootstrap skip\` 可跳过身份初始化)_`
}

export function renderBootstrapRequest(
  field: string,
  turnsCompleted?: number,
  turnsMax?: number,
): string {
  const hint = FIELD_HINTS[field] ?? field
  const turn = (turnsCompleted ?? 0) + 1
  const max = turnsMax ?? TURNS_MAX
  const progress = renderProgressTag(turn, max)

  return `## Bootstrap Pending — 身份初始化 (${turn}/${max})

你正在和一位还没完成身份设置的用户对话。本轮你需要朝目标推进：
**收集字段：${hint}**

判断用户上一条消息，从下面四类里选**最匹配**的一种回应方式：

1) 用户给出了字段答案
   → 用一句话简短致谢/确认，然后过渡到下一字段
   例："好的，记住你是后端工程师。那你的目标用户群体是？"

2) 用户在打招呼或闲聊（如"你好""嗨""在吗"）
   → 先回应问候，再用一两句说明："我是 my-agent，正在做一次性的身份初始化，
     这样我之后才能更贴近你的工作方式。一共 ${max} 个问题，大概 1 分钟。
     第一个问题：${hint}"

3) 用户在问元问题（如"你是谁""为什么问这个"）
   → 用一两句回答 + 解释 bootstrap 用途 + 自然过渡到本轮字段

4) 用户表达犹豫或想跳过
   → 共情一句，告知"可以随时输入 /bootstrap skip 跳过"，
     同时邀请："或者我们继续？${hint}"

5) 用户在让你做事（读文件/执行命令）
   → 不要拒绝。直接调对应工具，系统会返回错误。
     拿到错误后，把错误转告用户，再回到本轮字段问题。

通用约束：
- 全程中文，语气友好但不油腻
- 不要输出英文字段名（role/audience/tone/…）
- 不要长篇大论，整段回复控制在 1-3 句（分类 2/3 可放宽到 4 句）
- 不要假装 bootstrap 已完成
- 不要复述用户消息

回复末尾必须带一行进度提示：
${progress}`
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
