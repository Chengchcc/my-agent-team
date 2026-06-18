import type { IssueStatus } from "../issue/entities.js";

/** ── 单一事实来源（M18.2 起归属 orchestrator）──────────────
 *  状态空间 + "每一步谁干、给什么 prompt" 都由这张表唯一定义。
 *  M18.2 它是固定线性常量；M19 升级为"从配置/DB 读"——届时下面的纯函数与
 *  reactor 完全不用改，扩展点收敛到"转移表数据从哪来"一处。
 *  **不变量：必须按生命周期拓扑顺序书写**（看板列序 = 书写序，见 deriveStatuses）。 */
export interface Transition {
  from: IssueStatus;
  to: IssueStatus;
  /** 这一棒由哪个 agent 干。指向一个已配置（template 物化角色）的 agent。
   *  系统无独立 role 概念——角色性长在 agent 文件里。 */
  agentId: string;
  /** 起 run 时的 prompt 模板，仅 {{var}} 字符串插值，无 DSL。 */
  promptTemplate: string;
}

export const TRANSITIONS = [
  {
    from: "planned",
    to: "in_progress",
    agentId: "planner",
    promptTemplate: "为 Issue「{{title}}」制定开发计划并开始实现。",
  },
  {
    from: "in_progress",
    to: "in_review",
    agentId: "developer",
    promptTemplate: "完成 Issue「{{title}}」的实现，提交待 Review。",
  },
  {
    from: "in_review",
    to: "done",
    agentId: "reviewer",
    promptTemplate: "Review Issue「{{title}}」的实现，通过则标记完成。",
  },
] as const satisfies ReadonlyArray<Transition>;

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

export const ISSUE_STATUSES: readonly IssueStatus[] = deriveStatuses(TRANSITIONS);
export const LEGAL_TRANSITIONS: Readonly<Record<IssueStatus, IssueStatus[]>> =
  deriveLegalMap(TRANSITIONS);
