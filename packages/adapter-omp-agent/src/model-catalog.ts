/** Static model catalog for omp. omp has no model enumeration command
 *  (D3 risk #2): the table lists the models this deployment actually uses,
 *  in the canonical `<provider>/<model>` id format. Update when the
 *  provider/model surface changes. */

import type { BackendModel, BackendModelCatalog } from "@chengchenccc/agent-contract";

export class OmpModelCatalog {
  list(): Promise<BackendModelCatalog> {
    return Promise.resolve({
      backendKind: "omp",
      models: OMP_MODELS,
    });
  }
}

const deepseek = (id: string, reasoning: boolean): BackendModel => ({
  id: `deepseek/${id}`,
  displayName: `DeepSeek ${id}`,
  reasoning,
  // Metadata measured from DeepSeek's /models response (2026-09-23). The
  // per-provider effort surface (high..xhigh, xhigh→max) lives in the
  // deployment's models.yml, not in this table.
  inputModalities: ["text", "image"],
  contextWindow: 1_048_576,
  maxOutputTokens: 393_216,
  // ponytail: can't reflect the keys inside omp's own models.yml from here;
  // the config-time (backendKind, model) check and the /api/models
  // served-lookup cover the real honesty gaps.
  available: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

/** Only the ids this deployment's models.yml actually declares. omp has no
 *  model enumeration command, and `deepseek-chat` / `deepseek-reasoner`
 *  were measured to die at startup (they fall back to the default
 *  openrouter provider, which has no key) — they must not be offered. */
const OMP_MODELS: readonly BackendModel[] = [
  deepseek("deepseek-v4-flash", true),
  deepseek("deepseek-v4-pro", true),
];
