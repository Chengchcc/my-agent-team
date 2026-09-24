import { Elysia } from "elysia";

/** Web-facing model DTO. Mirrors apps/web/src/lib/api.ts listModels type —
 *  keep both in sync (e2e-contract-rules). */
export interface WebModel {
  id: string;
  name: string;
  available?: boolean;
  reasoning: boolean;
  input: readonly string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  /** Producing backend kind (oma / claude_code / pi / omp). The
   *  same provider/model id may exist under several kinds — the UI groups
   *  by kind first (D3). */
  backendKind: string;
}

export interface ModelsCatalog {
  list(): Promise<WebModel[]>;
}

/** Per-backend catalog health (GET /api/models/readiness): unlike
 *  /api/models, one failing backend degrades ONLY its own row — the
 *  Promise.all in the aggregate endpoint fails wholesale, which is the
 *  exact blind spot this endpoint exists to expose. */
export interface BackendReadinessEntry {
  backendKind: string;
  catalogOk: boolean;
  models: number;
  available: number;
  error: string | null;
}

export function modelRoutes(
  catalog: ModelsCatalog,
  backendReadiness?: () => Promise<BackendReadinessEntry[]>,
) {
  return new Elysia()
    .get("/api/models", async () => {
      const models = await catalog.list();
      return { providers: groupByProvider(models) };
    })
    .get("/api/models/readiness", async () => ({
      backends: backendReadiness ? await backendReadiness() : [],
    }));
}

/** `/api/models` catalog ids are composite `<provider>/<model>`; the provider
 *  is everything before the FIRST slash (openrouter model ids contain more). */
export function providerOfModelId(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "unknown";
}

export function bareModelId(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(slash + 1) : id;
}

/** Group a flat model list into provider buckets. */
export function groupByProvider(models: WebModel[]): Array<{
  id: string;
  name: string;
  models: WebModel[];
}> {
  const byProvider = new Map<string, WebModel[]>();
  for (const m of models) {
    const provider = providerOfModelId(m.id);
    const list = byProvider.get(provider) ?? [];
    list.push({ ...m, id: bareModelId(m.id) });
    byProvider.set(provider, list);
  }
  return [...byProvider.entries()].map(([id, models]) => ({ id, name: id, models }));
}
