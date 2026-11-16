import type { AgentRow } from "@/lib/api";

/** ADR 0046 ambient rule, as the read model carries it (`agent: null` for
 *  "the conversation's own agent"). */
export type AmbientRuleRow = NonNullable<AgentRow["lark"]>["ambientRules"][number];

/** The PATCH body shape. The difference that matters: the DTO says
 *  `agent: string | null`, the wire takes it as OPTIONAL — an explicit null is
 *  rejected by the route's type. Keeping the two shapes apart here is what
 *  stops "empty target" from turning into a 400. */
export interface AmbientRuleWire {
  id: string;
  keyword: string;
  mode: "record" | "act";
  instruction: string;
  agent?: string;
  chats: string[];
  senders: string[];
}

export function ruleToWire(rule: AmbientRuleRow): AmbientRuleWire {
  const { agent, ...rest } = rule;
  return agent === null || agent === "" ? rest : { ...rest, agent };
}

/** Comma/space separated ids → the array the route expects. */
export function splitList(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** A readable, stable id derived from the keyword — the event ledger records
 *  it, so it must be recognisable. Falls back to a timestamp when the keyword
 *  has no ASCII/CJK word characters to keep. */
export function deriveRuleId(keyword: string, now: number = Date.now()): string {
  const slug = keyword
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 40) : `rule-${now.toString(36)}`;
}
