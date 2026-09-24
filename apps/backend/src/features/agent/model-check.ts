import { resolveModelAlias } from "@chengchenccc/ai";

/** Minimal view of a backend registry entry: only its catalog matters here. */
export interface ModelCatalogLike {
  list(): Promise<{ models: ReadonlyArray<{ id: string }> }>;
}

/** Config-time (backendKind, model) consistency — the run would die later
 *  anyway (roadmap: `oma + deepseek/deepseek-chat` was accepted by PATCH and
 *  killed the run), so refuse the pair at save time.
 *
 *  Degrade rules, in order of silence:
 *  - an unknown backend kind accepts (the API schema already restricts kinds;
 *    this check must not duplicate that gate);
 *  - a catalog that fails to list accepts — configuration must not depend on
 *    a child process being up;
 *  - the id is resolved through MODEL_ALIASES first, so old ids keep saving. */
export function createModelCatalogCheck(opts: {
  backends: Readonly<Record<string, { catalog: ModelCatalogLike }>>;
}): (backendKind: string, provider: string, modelId: string) => Promise<boolean> {
  return async (backendKind, provider, modelId) => {
    const entry = opts.backends[backendKind];
    if (!entry) return true;
    try {
      const wanted = resolveModelAlias(`${provider}/${modelId}`);
      return (await entry.catalog.list()).models.some((m) => m.id === wanted);
    } catch {
      return true;
    }
  };
}
