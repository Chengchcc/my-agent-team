/** Issue — a work unit with its own state-machine lifecycle, spanning
 *  multiple runs on a single bound thread. The only new domain ontology in M18. */
export interface IssueRow {
  issueId: string;
  projectId: string;
  title: string;
  status: IssueStatus;
  /** The thread this Issue runs on. Reuses the existing run载体, no new exec mechanism. */
  threadId: string;
  createdAt: number;
  updatedAt: number;
}

export type IssueStatus = "planned" | "in_progress" | "in_review" | "done";

/** ── 单一事实来源 ──────────────────────────────────────────
 *  状态空间由这张转移表唯一定义。M18.1 它是固定常量（对应 Orchestrator
 *  「固定线性转移表」设计）；M18.2 起整张表移交 orchestrator 模块，M19 它从
 *  `const` 长成「从配置/DB 读」——届时下面两个派生函数完全不用改。 */
const TRANSITIONS = [
  { from: "planned", to: "in_progress" },
  { from: "in_progress", to: "in_review" },
  { from: "in_review", to: "done" },
] as const satisfies ReadonlyArray<{ from: IssueStatus; to: IssueStatus }>;

/** 从转移表派生有序状态集合（= 看板列顺序）。不再手写第二份常量。
 *  **不变量：`TRANSITIONS` 必须按生命周期拓扑顺序书写。**
 *  本函数取"首次出现顺序"(Set 插入序)，所以看板列顺序 = 转移表书写顺序。
 *  新增转移（如 `planned→cancelled`）要插在保证拓扑序的位置，否则列序错乱。
 *  M19 若改为从配置/DB 读，需在数据源侧保证同一顺序约束。 */
function deriveStatuses(table: typeof TRANSITIONS): IssueStatus[] {
  const seen = new Set<IssueStatus>();
  for (const t of table) {
    seen.add(t.from);
    seen.add(t.to);
  }
  return [...seen];
}

/** 从转移表派生 from → 合法 to 列表的映射。 */
function deriveLegalMap(table: typeof TRANSITIONS): Record<IssueStatus, IssueStatus[]> {
  const map = Object.fromEntries(deriveStatuses(table).map((s) => [s, [] as IssueStatus[]]));
  for (const t of table) map[t.from]!.push(t.to);
  return map as Record<IssueStatus, IssueStatus[]>;
}

export const ISSUE_STATUSES: readonly IssueStatus[] = deriveStatuses(TRANSITIONS);
export const LEGAL_TRANSITIONS: Readonly<Record<IssueStatus, IssueStatus[]>> =
  deriveLegalMap(TRANSITIONS);
