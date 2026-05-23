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
  let remain = ''
  if (turnsCompleted !== undefined && turnsMax !== undefined) {
    remain = `（剩余 ${turnsMax - turnsCompleted}/${turnsMax} 轮）`
  }
  return `<bootstrap_request>\n本轮你的额外职责：用一句中文（≤50字）向用户提问，仅围绕字段「${field}」收集信息。除问题本身外不要输出其它内容。${remain}\n</bootstrap_request>`
}

export const DEFAULT_BOOTSTRAP_MD = `---
status: pending
turns_completed: 0
turns_max: 6
required_fields: ["role","audience","tone","expertise","constraints"]
collected: {}
---

# Agent Identity Bootstrap

我还不知道你希望我是谁。开场后我会用最多 6 轮对话向你确认。
每轮我只问一个最关键的问题，你回答后我会更新本文件的 collected 字段
并刷新 identity.md 草稿；当 required_fields 全部收齐或达到 turns_max，
我会冻结身份并把本文归档为 bootstrap.archived.md。
`
