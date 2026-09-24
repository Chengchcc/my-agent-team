/**
 * Which models a provider actually serves, versus which ones we declare.
 *
 * The built-in catalog is hand-maintained, and nothing compared it to
 * reality: it shipped `deepseek-v4-flash` for weeks while the provider only
 * ever answered `deepseek-flash`. Picking it in the UI produced a run that
 * died at dispatch, which in the chat looks exactly like the bot ignoring
 * the message.
 *
 * Discovery fixes the half that can be fixed automatically. Two response
 * shapes exist among the providers we declare, both captured from the live
 * endpoints:
 *
 *   DeepSeek  {"data":[{"id","name","context_window","max_output_tokens",
 *                        "input_modalities","effort":{"supported_levels"}}]}
 *   GLM/Z.AI  {"data":[{"id","object","created","owned_by"}]}     (ids only)
 *
 * So a provider can confirm *existence* (and sometimes correct metadata),
 * but never supply everything: **pricing is in none of them**. That is why
 * this module answers "which ids are real", not "what is this model".
 */

/** One entry with the only field we read. Narrowing beats casting here:
 *  the payload is external, and a missing `id` must drop the entry rather
 *  than become a silently-wrong read. */
function isModelIdEntry(value: unknown): value is { id: string } {
  if (typeof value !== "object" || value === null || !("id" in value)) return false;
  return typeof value.id === "string" && value.id.length > 0;
}

/** Ids a provider reports, tolerant of the shapes seen in the wild. */
export function parseServedModelIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) return [];
  const data = payload.data;
  if (!Array.isArray(data)) return [];
  return data.filter(isModelIdEntry).map((entry) => entry.id);
}

export interface ModelDrift {
  /** Declared and served: offer it. */
  confirmed: string[];
  /** Declared but NOT served. Offering these is the shipped bug; the caller
   *  should mark them unavailable rather than let a run die later. */
  unserved: string[];
  /** Served but not declared: the provider has models we do not describe.
   *  They are real, but without an entry we cannot say what they cost. */
  undeclared: string[];
}

/** Compare the declared catalogue against what the provider just told us. */
export function diffServedModels(
  declaredIds: readonly string[],
  servedIds: readonly string[],
): ModelDrift {
  const served = new Set(servedIds);
  const declared = new Set(declaredIds);
  return {
    confirmed: declaredIds.filter((id) => served.has(id)),
    unserved: declaredIds.filter((id) => !served.has(id)),
    undeclared: servedIds.filter((id) => !declared.has(id)),
  };
}

/** One line for logs and ops views; "" when nothing drifted. */
export function describeDrift(providerId: string, drift: ModelDrift): string {
  const parts: string[] = [];
  if (drift.unserved.length > 0) {
    parts.push(`declared but not served: ${drift.unserved.join(", ")}`);
  }
  if (drift.undeclared.length > 0) {
    parts.push(`served but not declared: ${drift.undeclared.join(", ")}`);
  }
  if (parts.length === 0) return "";
  return `${providerId}: ${parts.join("; ")}`;
}
