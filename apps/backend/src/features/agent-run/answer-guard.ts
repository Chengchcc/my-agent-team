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

function riskFlag(payload: Readonly<Record<string, unknown>>, key: string): boolean {
  const risk = payload.risk;
  return (
    typeof risk === "object" && risk !== null && (risk as Record<string, unknown>)[key] === true
  );
}

function irreversible(payload: Readonly<Record<string, unknown>>): boolean {
  return riskFlag(payload, "irreversible");
}

function beyondScope(payload: Readonly<Record<string, unknown>>): boolean {
  return riskFlag(payload, "beyondScope");
}

/** The frozen policy a run was started under. */
export interface FrozenScope {
  readonly toolPolicy: {
    readonly deny: readonly string[];
    readonly allow: readonly string[];
    readonly denyCommands?: readonly string[];
  } | null;
}

function payloadCommand(payload: Readonly<Record<string, unknown>>): string | null {
  const input = payload.input;
  if (typeof input !== "object" || input === null) return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

function payloadPath(payload: Readonly<Record<string, unknown>>): string | null {
  const input = payload.input;
  if (typeof input !== "object" || input === null) return null;
  const raw = input as { path?: unknown; file_path?: unknown };
  const path = raw.path ?? raw.file_path;
  return typeof path === "string" ? path : null;
}

/** Does answering this request mean granting something the run's frozen policy
 *  did not include? It reads only what the run already froze (denied commands,
 *  allowed write paths). Deliberately narrow: it refuses to hand a visibly
 *  out-of-scope decision to an agent, and never widens anything itself. */
export function beyondFrozenScope(
  payload: Readonly<Record<string, unknown>>,
  scope: FrozenScope,
): string | undefined {
  const policy = scope.toolPolicy;
  if (policy === null) return undefined;
  const command = payloadCommand(payload);
  if (command !== null) {
    const hit = (policy.denyCommands ?? []).find((denied) => command.includes(denied));
    if (hit !== undefined) {
      return `the command matches ${JSON.stringify(hit)}, which this run's frozen policy denies`;
    }
  }
  const path = payloadPath(payload);
  if (path !== null && policy.allow.length > 0 && !policy.allow.some((p) => path.startsWith(p))) {
    return `the path ${JSON.stringify(path)} is outside the write paths this run was authorised for`;
  }
  return undefined;
}

/** `undefined` when the answer is allowed; otherwise the reason to show. */
export function answerRefusal(action: AnswerableAction, agentId: string): string | undefined {
  if (action.status !== "pending") {
    return `request ${action.actionId} is no longer pending`;
  }
  if (irreversible(action.payload)) {
    return "this request is marked irreversible: only the person may allow or deny it — escalate with ask_question instead of answering";
  }
  if (beyondScope(action.payload)) {
    return "this request is beyond the scope this run was authorised for: only the person may decide it — escalate with ask_question instead of answering";
  }
  if (action.owner !== `agent:${agentId}`) {
    return `request ${action.actionId} is owned by ${action.owner ?? "user"}, not you`;
  }
  return undefined;
}
