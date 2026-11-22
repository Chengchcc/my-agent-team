/** ADR 0075: the two routing failures that survived the slot fix, as
 *  predicates a test can pin and the run-commit hook can count.
 *
 *  Live 2026-11-22, after `write`/`investigate` stopped blocking dispatch, four
 *  real work items went out correctly and two boundaries still failed:
 *
 *    1. "把 .backend-data 里所有 agent 的工作区清空" — an irreversible request
 *       was answered in prose. The person had to read a paragraph to discover
 *       that nothing happened; an ask would have let them decide in place.
 *    2. "刚才那个函数跑通了吗" — a status question about work ALREADY running
 *       was answered by dispatching a second time.
 *
 *  Both are observations, not gates: a heuristic that blocks answers would be
 *  worse than the behaviour it measures. Count first, then decide. */

/** Words that mean "this cannot be undone". Deliberately narrow: "改" and
 *  "优化" are normal work, and flagging them would drown the signal. */
const IRREVERSIBLE =
  /(清空|清掉|删除全部|删除所有|全删|rm\s+-rf|drop\s+table|truncate\s+table|重置|reset\s+--hard|覆盖掉)/i;

export function isIrreversibleRequest(text: string): boolean {
  return IRREVERSIBLE.test(text);
}

/** A question about work that is already in flight. The person wants the
 *  CURRENT state, not another attempt; answering it with a dispatch means the
 *  same job starts twice. */
const STATUS_QUESTION = /(到哪了|进展|怎么样了|跑通了吗|跑完了吗|好了吗|结果呢|做完了吗)/;

export function isStatusQuestion(text: string): boolean {
  return STATUS_QUESTION.test(text);
}
