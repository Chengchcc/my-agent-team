import { ulid } from "../../infra/ids.js";
import type { AmbientRule } from "../agent/agent-config.js";
import type { AgentService } from "../agent/index.js";
import type { AmbientDecision, AmbientSource, ProactiveEvent } from "./domain.js";
import { matchAmbientRule } from "./domain.js";
import type { ProactiveEventPort } from "./ports.js";

/** How much of the observed message is kept in the event ledger. */
const SNIPPET_CHARS = 200;

export interface ProactiveService {
  /** ADR 0046 observe-seam evaluation. Returns null when no rule matches
   *  (or anything failed — ambient is an enhancement, never a new failure
   *  mode for the human's message). A non-null result HAS been recorded. */
  evaluate(input: {
    agentId: string;
    conversationId: string;
    senderMemberId: string;
    source: AmbientSource;
    text: string;
  }): Promise<AmbientDecision | null>;
  listEvents(filter: { agentId?: string; limit?: number }): ProactiveEvent[];
}

export function createProactiveService(deps: {
  port: ProactiveEventPort;
  /** Structural: only the config read is needed (test doubles stay small). */
  agentSvc: Pick<AgentService, "getById">;
  now?: () => number;
  idGen?: () => string;
}): ProactiveService {
  const { port, agentSvc } = deps;
  const now = deps.now ?? Date.now;
  const idGen = deps.idGen ?? ulid;

  return {
    async evaluate(input) {
      let rules: readonly AmbientRule[];
      try {
        // The config cache is parsed (AgentRow.config: AgentConfig), so a
        // rule here already passed the act-requires-instruction refinement.
        const row = await agentSvc.getById(input.agentId);
        rules = row.config.lark.ambient?.rules ?? [];
      } catch (err) {
        console.error(
          `[proactive] agent config load failed for ${input.agentId}:`,
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
      const rule = matchAmbientRule(rules, {
        chatId: input.source.chatId,
        senderMemberId: input.senderMemberId,
        text: input.text,
      });
      if (!rule) return null;

      const outcome: AmbientDecision["outcome"] = rule.mode === "act" ? "triggered" : "recorded";
      // Record FIRST: "act without an audit row" must degrade to "no act"
      // (ADR 0046 invariant), so a write failure here cancels the promotion.
      try {
        port.insertEvent({
          id: idGen(),
          ts: now(),
          agentId: input.agentId,
          conversationId: input.conversationId,
          ruleId: rule.id,
          mode: rule.mode,
          outcome,
          chatId: input.source.chatId,
          senderMemberId: input.senderMemberId,
          snippet: input.text.slice(0, SNIPPET_CHARS),
        });
      } catch (err) {
        console.error(
          `[proactive] event insert failed (rule ${rule.id} NOT promoted):`,
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
      return { rule, outcome };
    },

    listEvents(filter) {
      return port.listEvents({ agentId: filter.agentId, limit: filter.limit ?? 50 });
    },
  };
}
