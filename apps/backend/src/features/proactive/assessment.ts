import {
  BUILTIN_CATALOG,
  buildAllModels,
  createModelRuntime,
  createProvider,
  type ModelRuntime,
} from "@chengchenccc/ai";
import type { AIMessageChunk, Message } from "@chengchenccc/message";
import type { AgentCard, AssessmentResult } from "./domain.js";

/** ADR 0048: the semantic net under the deterministic rules. This module is
 *  the prompt, the parser and the configured model caller; the scheduling,
 *  gating and promotion live in the service. */

/** Hard ceiling on one assessment: the message POST already returned (the
 *  seam is async), this bounds background resources, not user latency. */
export const ASSESSMENT_TIMEOUT_MS = 25_000;

export type AssessmentCredentials = (providerId: string) => {
  apiKey?: string;
  baseUrl?: string;
};

/** One observed message as the assessor sees it. */
export interface AssessmentInput {
  text: string;
  senderMemberId: string;
  chatId: string;
  cards: readonly AgentCard[];
}

function renderCards(cards: readonly AgentCard[]): string {
  return cards
    .map((c) => {
      const skills = c.skills.length > 0 ? `\n  技能: ${c.skills.join("；")}` : "";
      return `- ${c.id}（${c.name}）${c.description ? `：${c.description}` : ""}${skills}`;
    })
    .join("\n");
}

export function buildAssessmentPrompt(input: AssessmentInput): Message[] {
  const system = [
    "你是任务分派研判器。一个 agent 团队在聊天群观察未被点名（未 @ 任何人）的消息，",
    "判断某条消息是否构成应该接下的工作；若是，从团队里选最合适的执行者。",
    "只把「明确是给这个团队的活」判为接下：求助、报障、明确的请求。闲聊、讨论、",
    "与团队无关的话题一律不接（accept=false）。拿不准就是不接。",
    "instruction 必须引用请求者的原话，不要转述、不要替它做实现计划（ADR 0047 契约）。",
    '只回一个 JSON 对象：{"accept": boolean, "agent": "团队 id 或 null", "reason": "一句话", "instruction": "给执行者的任务框定"}',
  ].join("");
  const user = [
    "团队成员（能力卡）：",
    renderCards(input.cards),
    "",
    `消息（来自 ${input.senderMemberId}，群 ${input.chatId}，未被点名）：`,
    input.text,
  ].join("\n");
  return [{ role: "user", text: `${system}\n\n---\n${user}` }];
}

/** Parse the model's answer. Tolerates code fences and stray prose; returns
 *  null when nothing usable survives (the caller records an error event). */
export function parseAssessment(raw: string): AssessmentResult | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? (fenced[1] ?? "") : trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.accept !== "boolean") return null;
  const agent = typeof obj.agent === "string" && obj.agent.length > 0 ? obj.agent : null;
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  const instruction = typeof obj.instruction === "string" ? obj.instruction : "";
  if (obj.accept && instruction.trim().length === 0) return null;
  return { accept: obj.accept, agent, reason, instruction };
}

/** The model call as the service injects it — a seam so tests stub the model
 *  and production wires the configured runtime. */
export type AssessmentCall = (input: AssessmentInput) => Promise<string>;

/** A ModelRuntime over the builtin catalogue — the same shape the summarizer
 *  uses (keys resolve per call, registration is not key-filtered). */
function createAssessmentRuntime(): ModelRuntime {
  const runtime = createModelRuntime();
  const built = buildAllModels(BUILTIN_CATALOG);
  for (const [providerId, entry] of Object.entries(built)) {
    runtime.registerProvider(
      createProvider({
        id: providerId,
        name: providerId,
        baseUrl: entry.spec.baseUrl,
        auth: {},
        models: entry.models,
      }),
    );
  }
  return runtime;
}

/** Production caller: `<provider>/<model>` from the assessment settings.
 *  Returns undefined when the spec is absent (assessment then stays off) and
 *  throws on a malformed spec — misconfiguration is loud, not silent. */
export function createConfiguredAssessment(
  spec: string | undefined,
  credentialFor: AssessmentCredentials,
): AssessmentCall | undefined {
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`assessment model must be "<provider>/<model>", got: ${spec}`);
  }
  const providerId = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const runtime = createAssessmentRuntime();
  return async (input) => {
    const credential = credentialFor(providerId);
    let out = "";
    const stream = runtime.stream(providerId, modelId, buildAssessmentPrompt(input), {
      ...(credential.apiKey ? { apiKey: credential.apiKey } : {}),
      ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}),
    }) as AsyncIterable<AIMessageChunk>;
    for await (const chunk of stream) {
      if (chunk.delta?.type === "text" && chunk.delta.text) out += chunk.delta.text;
    }
    return out;
  };
}
