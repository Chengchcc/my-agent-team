/** Static model catalog for the acp kind: the ids are REGISTRY KEYS, not
 *  provider models — the LLM behind each agent stays that agent's own
 *  configuration (omp's models.yml, the cc bridge's advertised config
 *  options…). An agent record picks its agent with {provider: "acp",
 *  model: "<registry key>"}. Context/output numbers are placeholders the
 *  product never enforces across this boundary; they satisfy the catalog
 *  shape the preflight and /api/models aggregation read. */

import type { BackendModel, BackendModelCatalog } from "@chengchenccc/agent-contract";
import { ACP_AGENTS } from "./registry.js";

export class AcpModelCatalog {
  list(): Promise<BackendModelCatalog> {
    // Ids follow the catalog convention `provider/model` — the create-time
    // model check matches on the joined string.
    return Promise.resolve({
      backendKind: "acp",
      models: Object.entries(ACP_AGENTS).map(([id, entry]) => toModel(`acp/${id}`, entry.name)),
    });
  }
}

function toModel(id: string, displayName: string): BackendModel {
  return {
    id,
    displayName,
    reasoning: false,
    inputModalities: ["text"],
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    available: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
