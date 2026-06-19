import type { IssueStatus } from "../issue/entities.js";

/**
 * Fixed lifecycle order — shared by all Projects.
 * Only "who does each step" varies per Project (via ColumnConfig).
 *
 * draft→planned is a legal transition (for manual drag), but it will NOT
 * appear in a Project's Transition[] unless the Project has a ColumnConfig
 * for draft — which it normally won't (draft→planned is human-triggered,
 * not reactor-triggered).
 */
export const ORDER: IssueStatus[] = ["draft", "planned", "in_progress", "in_review", "done"];

/** ── 单一事实来源（M18.2 起归属 orchestrator）──────────────
 *  Transition 描述"从一个 status 到下一个 status 由谁干"。
 *  M18.4: 不再有全局 TRANSITIONS 常量。
 *  转移表按 Project 从 ColumnConfig 派生（见 column-config service 的
 *  transitionsForProject），下面的纯函数与 reactor 完全不用改。 */
export interface Transition {
  from: IssueStatus;
  to: IssueStatus;
  /** 这一棒由哪个 agent 干。M18.4 起是真实 Agent id（ulid），不是字面量。 */
  agentId: string;
  /** 起 run 时的 prompt 模板，仅 {{var}} 字符串插值，无 DSL。 */
  promptTemplate: string;
}

/** 从 ORDER 相邻对生成一个固定 Transition[]，仅用于派生 ISSUE_STATUSES
 *  和 LEGAL_TRANSITIONS（这两个是全局的、不分 Project）。
 *  reactor 用的 Transition[] 来自 columnConfigSvc.transitionsForProject()。 */
function fixedTransitions(): Transition[] {
  const out: Transition[] = [];
  for (let i = 0; i < ORDER.length - 1; i++) {
    out.push({
      from: ORDER[i]!,
      to: ORDER[i + 1]!,
      agentId: "",
      promptTemplate: "",
    });
  }
  return out;
}

/** 从转移表派生有序状态集合（= 看板列顺序）。取首次出现顺序（Set 插入序）。 */
export function deriveStatuses(table: ReadonlyArray<Transition>): IssueStatus[] {
  const seen = new Set<IssueStatus>();
  for (const t of table) {
    seen.add(t.from);
    seen.add(t.to);
  }
  return [...seen];
}

/** 从转移表派生 from → 合法 to 列表的映射。 */
export function deriveLegalMap(
  table: ReadonlyArray<Transition>,
): Record<IssueStatus, IssueStatus[]> {
  const map = Object.fromEntries(deriveStatuses(table).map((s) => [s, [] as IssueStatus[]]));
  for (const t of table) map[t.from]!.push(t.to);
  return map as Record<IssueStatus, IssueStatus[]>;
}

/** 查 from 状态对应的那条转移（线性表里 from 唯一）。无则返回 undefined（如终态 done）。 */
export function nextTransition(
  table: ReadonlyArray<Transition>,
  from: IssueStatus,
): Transition | undefined {
  return table.find((t) => t.from === from);
}

/** Global: every Project has the same status set and legal transitions.
 *  Only "who does each step" varies per Project. */
const FIXED = fixedTransitions();
export const ISSUE_STATUSES: readonly IssueStatus[] = deriveStatuses(FIXED);
export const LEGAL_TRANSITIONS: Readonly<Record<IssueStatus, IssueStatus[]>> =
  deriveLegalMap(FIXED);
