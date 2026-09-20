import type {
  AskQuestionInput,
  AskQuestionItem,
  AskQuestionOption,
  AskQuestionResult,
} from "@chengchenccc/agent-contract";
import type { PluginTool } from "../index.js";

/** An option as the contract defines it. A bare string is the shorthand models
 *  emit constantly (the old schema invited it) — it is normalized rather than
 *  refused, because refusing costs a whole round trip for no user benefit. What
 *  must NOT survive is a shapeless option: an undefined value would come back
 *  as an answer of `[null]`, which the model cannot tell from a real answer. */
function normalizeOption(raw: unknown): AskQuestionOption | { error: string } {
  if (typeof raw === "string") return { value: raw, label: raw };
  if (typeof raw !== "object" || raw === null) return { error: "needs a string or {value, label}" };
  const o = raw as Record<string, unknown>;
  if (typeof o.value !== "string" || o.value === "")
    return { error: "needs a non-empty string value" };
  if (o.label !== undefined && typeof o.label !== "string") {
    return { error: "needs a string label" };
  }
  const option: AskQuestionOption = { value: o.value, label: o.label ?? o.value };
  if (typeof o.description === "string") option.description = o.description;
  if (typeof o.preview === "string") option.preview = o.preview;
  return option;
}

function normalizeInput(
  args: Readonly<Record<string, unknown>>,
): AskQuestionInput | { error: string } {
  const raw = args.questions;
  if (!Array.isArray(raw) || raw.length === 0)
    return { error: "questions must be a non-empty array" };
  const questions: AskQuestionInput["questions"] = [];
  for (const q of raw) {
    if (typeof q !== "object" || q === null) return { error: "each question must be an object" };
    const item = q as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.question !== "string") {
      return { error: "each question needs string id and question" };
    }
    const kind = item.kind === "text" ? "text" : "select";
    if (kind === "select") {
      const raw = Array.isArray(item.options) ? item.options : [];
      if (raw.length === 0) return { error: `question ${item.id}: select needs options` };
      const options: AskQuestionOption[] = [];
      for (let i = 0; i < raw.length; i++) {
        const option = normalizeOption(raw[i]);
        if ("error" in option) {
          return { error: `question ${item.id}: option ${i + 1} ${option.error}` };
        }
        options.push(option);
      }
      questions.push({
        ...(item as unknown as AskQuestionItem),
        kind,
        options,
      });
      continue;
    }
    questions.push({ ...(item as unknown as AskQuestionItem), kind });
  }
  return { questions };
}

/** Native ask_question tool (oh-my-pi style). Executes through the HITL ask
 *  pipeline (`options.ask`); absent pipeline = fail closed. */
export function createAskQuestionTool(): PluginTool {
  return {
    name: "ask_question",
    description:
      "Ask the user structured questions and wait for answers. Questions are select (options, optional multi/recommended/other) or text (free input). Returns {answers:[{id,selectedValues,freeText?,note?,timedOut?}]}. `timedOut` marks an answer that was auto-selected on timeout rather than chosen by the user — treat it as a guess, not consent.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique id for this question" },
              question: { type: "string", description: "The question text" },
              kind: { type: "string", enum: ["select", "text"] },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: { type: "string", description: "Answer value returned to you" },
                    label: { type: "string", description: "Text the user sees" },
                    description: { type: "string", description: "Optional explanatory line" },
                    preview: { type: "string", description: "Optional rich preview content" },
                  },
                  required: ["value", "label"],
                },
                description: "Required when kind=select",
              },
            },
            required: ["id", "question"],
          },
        },
      },
      required: ["questions"],
    },
    async execute(
      args: Readonly<Record<string, unknown>>,
      _signal?: AbortSignal,
      options?: {
        ask?: (input: AskQuestionInput) => Promise<AskQuestionResult | null>;
      },
    ): Promise<Readonly<Record<string, unknown>>> {
      const normalized = normalizeInput(args);
      if ("error" in normalized) return normalized;
      if (!options?.ask) return { error: "no ask pipeline configured" };
      const result = await options.ask(normalized);
      if (!result) return { error: "ask pipeline returned no answer" };
      return result as unknown as Record<string, unknown>;
    },
  };
}
