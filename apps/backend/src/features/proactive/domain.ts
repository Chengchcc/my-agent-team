import type { AmbientRule } from "../agent/agent-config.js";

/** Where an observed message came from. Today only lark; a new source (e.g.
 *  a GitHub webhook) would add a kind here and keep the same seam. */
export interface AmbientSource {
  kind: "lark";
  chatId: string;
}

/** What an evaluation decided about one observed message. `triggered` means
 *  the RULE said act — the actual run creation still happens in the
 *  conversation service on the normal enqueue path (ADR 0046 invariant:
 *  no second execution identity). */
export interface AmbientDecision {
  rule: AmbientRule;
  outcome: "recorded" | "triggered";
}

/** Durable "what the agent would have done" row (the record-mode ledger,
 *  and the audit trail for act-mode fires). */
export interface ProactiveEvent {
  id: string;
  ts: number;
  agentId: string;
  conversationId: string;
  ruleId: string;
  /** What the rule said: record | act. */
  mode: "record" | "act";
  /** What the system did: recorded | triggered. */
  outcome: "recorded" | "triggered";
  chatId: string | null;
  senderMemberId: string | null;
  /** First ~200 chars of the observed message text. */
  snippet: string;
}

const LARK_MEMBER_PREFIX = "human:lark:";

/** A sender rule may name the open_id (`ou_…`, the allowed_senders
 *  vocabulary) or the full member label (`human:lark:ou_…`). Both match. */
function senderCandidates(senderMemberId: string): readonly string[] {
  return senderMemberId.startsWith(LARK_MEMBER_PREFIX)
    ? [senderMemberId, senderMemberId.slice(LARK_MEMBER_PREFIX.length)]
    : [senderMemberId];
}

/** Pure first-match-wins rule evaluation. Array order is precedence: the
 *  operator puts narrow rules before broad ones. */
export function matchAmbientRule(
  rules: readonly AmbientRule[],
  input: { chatId: string; senderMemberId: string; text: string },
): AmbientRule | null {
  const senders = senderCandidates(input.senderMemberId);
  const haystack = input.text.toLowerCase();
  for (const rule of rules) {
    if (rule.chats.length > 0 && !rule.chats.includes(input.chatId)) continue;
    if (rule.senders.length > 0 && !rule.senders.some((s) => senders.includes(s))) continue;
    if (!haystack.includes(rule.keyword.toLowerCase())) continue;
    return rule;
  }
  return null;
}

/** The task framing an act rule gives the agent. The original message is
 *  quoted verbatim — it is the evidence, the instruction is the job. */
export function frameAmbientInput(rule: AmbientRule, text: string): string {
  return [
    `（环境规则「${rule.id}」命中，这条群消息被升格为任务）`,
    rule.instruction,
    "",
    "触发消息原文：",
    text,
  ].join("\n");
}
