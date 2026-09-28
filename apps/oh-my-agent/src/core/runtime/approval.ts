/** HITL approval (spec: 2026-08-26-plugin-trust-model-design.md): one handler
 *  type, three resolution pipelines (tui overlay / print+json fail-closed /
 *  rpc wire with deadline). */

export interface ApprovalRequest {
  readonly callId: string;
  readonly toolName: string;
  readonly input: unknown;
  /** Who asked: "permission" (ask-mode gate), "tool" (options.request), or
   *  "classifier" (auto-mode block escalated to the human). */
  readonly source: "permission" | "tool" | "classifier";
  readonly reason?: string;
  /** Execution context: true when the action runs inside the OS bash sandbox
   * (BashSandbox design, P4) — surfaces let the human distinguish "sandboxed,
   * auto-allowable" from "unsandboxed fallback". */
  readonly sandboxed?: boolean;
  /** Wall-clock ms after which this request fails closed. Absent = no
   *  deadline (surfaces then claim nothing). Stamped by requestApproval() so
   *  the wire, the durable row and the card all show ONE number. */
  readonly deadlineAt?: number;
}

export interface ApprovalDecision {
  readonly decision: "allow" | "deny";
  readonly reason?: string;
}

export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/** How long an approval may wait for a human before it fails closed.
 *  HITL over a chat surface means hours — the person may read the card the
 *  next morning — so the default is a day (user decision 2026-09-25, after
 *  two minutes routinely denied requests nobody had seen yet). Interactive
 *  surfaces that cannot wait still fail closed on their own (print/json use
 *  denyAllApprovals). `OMA_APPROVAL_TIMEOUT_MS` overrides; 0 = wait. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60_000;

export function approvalTimeoutMs(): number {
  const raw = process.env.OMA_APPROVAL_TIMEOUT_MS;
  const n = raw === undefined ? DEFAULT_APPROVAL_TIMEOUT_MS : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_APPROVAL_TIMEOUT_MS;
}

/** Resolve with a deadline; a silent human fails closed (deny). 0 = wait. */
export function withApprovalDeadline(
  p: Promise<ApprovalDecision>,
  timeoutMs: number,
): Promise<ApprovalDecision> {
  if (timeoutMs === 0) return p;
  return Promise.race([
    p,
    new Promise<ApprovalDecision>((resolve) =>
      setTimeout(
        () => resolve({ decision: "deny", reason: "approval deadline exceeded" }),
        timeoutMs,
      ),
    ),
  ]);
}

/** Ask the human with a deadline. The deadline is stamped ON the request, so
 *  every surface can say when the question expires instead of the human
 *  guessing (the wait is up to 24h; nothing else carried that number). */
export async function requestApproval(
  handler: ApprovalHandler,
  req: ApprovalRequest,
  timeoutMs: number,
): Promise<ApprovalDecision> {
  const stamped = timeoutMs === 0 ? req : { ...req, deadlineAt: Date.now() + timeoutMs };
  return withApprovalDeadline(handler(stamped), timeoutMs);
}

/** The fail-closed handler for headless one-shot modes (print/json). */
export function denyAllApprovals(req: ApprovalRequest): Promise<ApprovalDecision> {
  return Promise.resolve({
    decision: "deny",
    reason: `${req.toolName}: approval requested in non-interactive mode (fail-closed)`,
  });
}
