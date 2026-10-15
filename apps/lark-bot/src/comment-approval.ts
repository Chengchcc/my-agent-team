/**
 * A comment lane cannot paint a card, so a parked run (an approval, an ask) had
 * nowhere to appear: the live acceptance watched a run sit in `waiting` while
 * the thread stayed silent (2026-10-14). This is the comment-side twin of the
 * ask/approval card, and of the chat lane's rule that a reply in the thread IS
 * the answer (ADR 0037).
 *
 * Both halves are pure: the formatting that goes into the thread, and the
 * reading of the user's next comment. The wiring lives in main.ts.
 */

/** What the user has to see to decide: the action, and what to type back. */
export interface PendingQuestion {
  kind: "approval" | "ask";
  /** The action being approved (a command, a path) or the question text. */
  detail: string;
  /** Extra context: the tool's name for an approval, otherwise unused. */
  toolName?: string;
}

export const APPROVAL_HINT = "回复「允许」继续，或回复「拒绝」跳过这一步。";

/** The comment that carries the pending action. Deliberately plain: this text
 *  is read by a person in a document comment, not by the model. */
export function formatPendingQuestion(pending: PendingQuestion): string {
  const headline =
    pending.kind === "approval" ? "需要你确认一个动作，我才能继续：" : "需要你回答问题：";
  const tool = pending.toolName ? `（工具 ${pending.toolName}）` : "";
  const detail = pending.detail.trim() === "" ? "（动作内容为空）" : pending.detail.trim();
  return pending.kind === "approval"
    ? `${headline}\n\n${detail}\n${tool}\n\n${APPROVAL_HINT}`
    : `${headline}\n\n${detail}`;
}

/** What a follow-up comment means, when a run is parked. Anything else is a new
 *  request (the caller starts a run, exactly as it does today). */
export function parseApprovalAnswer(text: string): "allow" | "deny" | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === "") return null;
  const allow = ["允许", "同意", "批准", "可以", "allow", "approve", "yes", "y", "ok"];
  const deny = ["拒绝", "不行", "不要", "禁止", "deny", "reject", "no", "n"];
  // Exact match only: "允许，另外帮我..." is a new request, not an answer to
  // this one, and guessing there would silently swallow the new request.
  if (allow.includes(normalized)) return "allow";
  if (deny.includes(normalized)) return "deny";
  return null;
}
