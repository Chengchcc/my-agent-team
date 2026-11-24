/** Why an agent may NOT answer a parked request. One place, so the product
 *  tool's shape checks and the deployment's ownership checks cannot drift.
 *
 *  ADR 0075 lets the owner (usually the dispatcher) answer first. Three things
 *  are never an agent's to decide:
 *   - the request is no longer pending (someone else settled it),
 *   - it is owned by someone else,
 *   - it is marked irreversible. The mark is a FIELD a producer sets, not a
 *     name we guess from (audit 2026-11-24: a denylist reads as a check while
 *     checking nothing).
 */

export interface AnswerableAction {
  readonly actionId: string;
  readonly status: string;
  readonly owner?: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

function irreversible(payload: Readonly<Record<string, unknown>>): boolean {
  const risk = payload.risk;
  return (
    typeof risk === "object" &&
    risk !== null &&
    (risk as { irreversible?: unknown }).irreversible === true
  );
}

/** `undefined` when the answer is allowed; otherwise the reason to show. */
export function answerRefusal(action: AnswerableAction, agentId: string): string | undefined {
  if (action.status !== "pending") {
    return `request ${action.actionId} is no longer pending`;
  }
  if (action.owner !== `agent:${agentId}`) {
    return `request ${action.actionId} is owned by ${action.owner ?? "user"}, not you`;
  }
  if (irreversible(action.payload)) {
    return "this request is marked irreversible: only the person may allow or deny it — escalate with ask_question instead of answering";
  }
  return undefined;
}
