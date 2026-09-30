/** ADR 0040 R3, first step: the kinds that predate the ACP face keep working.
 *
 *  A run created before the ACP kinds existed carries one of these kinds and whatever model the
 *  agent had picked then. Both have to travel together: `AcpBackend` takes its registry key from
 *  the run's model id, and an id it does not recognise falls back to the DEFAULT agent — so
 *  translating the kind alone would silently run an agent nobody asked for. */
import { ACP_AGENTS } from "@chengchenccc/adapter-acp";
import type { BackendModelRef } from "@chengchenccc/agent-contract";

/** Legacy kind -> ACP registry key. The names match 1:1 except Claude Code, whose old kind is the
 *  adapter's name while its registry key is the agent's. */
const LEGACY_KIND_TO_AGENT: Readonly<Record<string, string>> = {
  claude_code: "claude",
  pi: "pi",
  omp: "omp",
};

/** The registry key an old kind names, or undefined when the kind is already ACP or unknown.
 *  `ACP_AGENTS` is the authority: an alias pointing at no registry entry is a bug, and returning
 *  it anyway would surface as the adapter's silent default. */
export function acpAgentForLegacyKind(kind: string): string | undefined {
  const key = LEGACY_KIND_TO_AGENT[kind];
  return key !== undefined && key in ACP_AGENTS ? key : undefined;
}

/** The model ref the ACP backend must receive for a legacy run. The registry key rides in the
 *  model id in the `acp/<key>` form the catalog uses, so `resolveAcpAgentKey` resolves the agent
 *  the kind named rather than falling back to the default. Null = this run is not a legacy one. */
export function aliasModelRefForAcp<K extends string>(
  ref: BackendModelRef<K>,
): BackendModelRef<"acp"> | null {
  const key = acpAgentForLegacyKind(ref.backendKind);
  if (key === undefined) return null;
  return {
    backendKind: "acp",
    modelId: `acp/${key}`,
    ...(ref.reasoningEffort === undefined ? {} : { reasoningEffort: ref.reasoningEffort }),
  };
}
