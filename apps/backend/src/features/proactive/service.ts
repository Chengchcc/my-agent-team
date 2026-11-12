import { ulid } from "../../infra/ids.js";
import type { AmbientRule } from "../agent/agent-config.js";
import type { AgentService } from "../agent/index.js";
import { ASSESSMENT_TIMEOUT_MS, type AssessmentCall, parseAssessment } from "./assessment.js";
import type {
  AgentCard,
  AmbientDecision,
  AmbientSource,
  AssessmentResult,
  ProactiveEvent,
} from "./domain.js";
import { matchAmbientRule } from "./domain.js";
import type { ProactiveEventPort } from "./ports.js";

/** How much of the observed message is kept in the event ledger. */
const SNIPPET_CHARS = 200;

/** The ADR 0048 gate, read from settings KV per message. */
export interface AssessmentGate {
  mode: "off" | "observe" | "auto";
  /** "<provider>/<model>" for the assessment call. */
  model?: string;
}

export interface ProactiveService {
  /** ADR 0046 observe-seam evaluation. Returns null when no rule matches
   *  (or anything failed — ambient is an enhancement, never a new failure
   *  mode for the human's message). A non-null result HAS been recorded.
   *  ADR 0048: a rule MISS with the assessment gate on schedules a
   *  background semantic assessment and still returns null — the message
   *  POST never waits for a model. */
  evaluate(input: {
    agentId: string;
    conversationId: string;
    senderMemberId: string;
    source: AmbientSource;
    text: string;
  }): Promise<AmbientDecision | null>;
  /** Awaits every in-flight background assessment (ADR 0048): tests use it
   *  for determinism; shutdown can use it so a restart drops nothing that
   *  a microtask could have finished. */
  drain(): Promise<void>;
  listEvents(filter: { agentId?: string; limit?: number }): ProactiveEvent[];
}

export function createProactiveService(deps: {
  port: ProactiveEventPort;
  /** Structural: only the config read is needed (test doubles stay small). */
  agentSvc: Pick<AgentService, "getById">;
  /** ADR 0048 gate reader (settings KV); absent = assessment always off. */
  assessmentGate?: () => AssessmentGate;
  /** The model call; absent = assessment off even when the gate says on. */
  assessmentCall?: AssessmentCall;
  /** The team roster with capability cards; absent = assessment off. */
  listCards?: () => Promise<readonly AgentCard[]>;
  /** ADR 0048 async promotion: runs when auto mode accepts. Absent = observe
   *  behaviour regardless of the gate (promotion is the bootstrap's wiring). */
  promote?: (input: {
    conversationId: string;
    agentId: string;
    toAgentId: string;
    senderMemberId: string;
    reason: string;
    instruction: string;
    text: string;
  }) => Promise<void>;
  now?: () => number;
  idGen?: () => string;
}): ProactiveService {
  const { port, agentSvc } = deps;
  const now = deps.now ?? Date.now;
  const idGen = deps.idGen ?? ulid;
  const inFlight = new Set<Promise<void>>();

  function recordEvent(event: ProactiveEvent): void {
    port.insertEvent(event);
  }

  function eventBase(input: {
    agentId: string;
    conversationId: string;
    senderMemberId: string;
    source: AmbientSource;
    text: string;
  }) {
    return {
      id: idGen(),
      ts: now(),
      agentId: input.agentId,
      conversationId: input.conversationId,
      chatId: input.source.chatId,
      senderMemberId: input.senderMemberId,
      snippet: input.text.slice(0, SNIPPET_CHARS),
    };
  }

  /** ADR 0048 background assessment. Every failure path ends in an error
   *  event + a log line — never a promotion, never a throw out of the
   *  background (an unhandled rejection would kill the backend). */
  async function assessInBackground(input: {
    agentId: string;
    conversationId: string;
    senderMemberId: string;
    source: AmbientSource;
    text: string;
  }): Promise<void> {
    const gate = deps.assessmentGate?.() ?? { mode: "off" };
    if (gate.mode === "off" || !deps.assessmentCall || !deps.listCards) return;
    let cards: readonly AgentCard[];
    try {
      cards = await deps.listCards();
    } catch (err) {
      console.error(
        "[proactive] roster load failed:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    if (cards.length === 0) return;

    let result: AssessmentResult | null;
    try {
      const raw = await Promise.race([
        deps.assessmentCall({
          text: input.text,
          senderMemberId: input.senderMemberId,
          chatId: input.source.chatId,
          cards,
        }),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), ASSESSMENT_TIMEOUT_MS).unref?.();
        }),
      ]);
      result = parseAssessment(String(raw ?? ""));
    } catch (err) {
      console.error(
        "[proactive] assessment call failed:",
        err instanceof Error ? err.message : String(err),
      );
      result = null;
    }
    const base = eventBase(input);
    if (!result) {
      // The observability for "why didn't it fire": the assessment itself
      // failed (error / unparseable / timeout). 宁可不动作。
      try {
        recordEvent({ ...base, ruleId: "assessment", mode: "assessment", outcome: "error" });
      } catch (err) {
        console.error(
          "[proactive] error event insert failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
      return;
    }
    if (!result.accept) return; // rejects are NOT recorded (noise control)
    if (gate.mode === "observe") {
      try {
        recordEvent({ ...base, ruleId: "assessment", mode: "assessment", outcome: "recorded" });
      } catch (err) {
        console.error(
          "[proactive] would-accept insert failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
      return;
    }
    // auto: record FIRST (act without an audit row = no act), then promote.
    const toAgentId = result.agent ?? input.agentId;
    try {
      recordEvent({ ...base, ruleId: "assessment", mode: "assessment", outcome: "triggered" });
    } catch (err) {
      console.error(
        "[proactive] assessment event insert failed (NOT promoted):",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    try {
      await deps.promote?.({
        conversationId: input.conversationId,
        agentId: input.agentId,
        toAgentId,
        senderMemberId: input.senderMemberId,
        reason: result.reason,
        instruction: result.instruction,
        text: input.text,
      });
    } catch (err) {
      console.error(
        `[proactive] assessment promotion to ${toAgentId} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

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
      if (!rule) {
        // ADR 0048: deterministic rules are the FAST path; the semantic net
        // only sees what they missed. Fire-and-forget — the POST returns as
        // an observation and never waits for the model.
        const task = assessInBackground(input)
          .catch(() => {})
          .finally(() => {
            inFlight.delete(task);
          });
        inFlight.add(task);
        return null;
      }

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

    async drain() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    listEvents(filter) {
      return port.listEvents({ agentId: filter.agentId, limit: filter.limit ?? 50 });
    },
  };
}
