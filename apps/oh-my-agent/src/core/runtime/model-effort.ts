import type { ReasoningEffort } from "@chengchenccc/agent-contract";
import { normalizeReasoningEffort, REASONING_EFFORTS } from "@chengchenccc/agent-contract";
import type { ProviderStreamOptions } from "@chengchenccc/ai";

export type { ReasoningEffort };
export { normalizeReasoningEffort, REASONING_EFFORTS };

/** Product enum → provider stream options. The ONE mapping on the runtime
 *  side (the contract owns the enum itself). Deliberately not model-aware:
 *  the field means "thinking effort", and a provider that cannot honor a
 *  rung degrades on its own side. */
export function reasoningEffortOptions(
  effort: string | undefined,
): Pick<ProviderStreamOptions, "thinking" | "effort"> {
  if (effort === "none") return { thinking: { type: "disabled" } };
  if (effort !== "low" && effort !== "high" && effort !== "max") return {};
  return {
    thinking: { type: "adaptive", display: "summarized" },
    // "max" is the product's top rung; the provider's is "xhigh".
    effort: effort === "max" ? "xhigh" : effort,
  };
}
