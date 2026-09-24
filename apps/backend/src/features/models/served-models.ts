import { BUILTIN_CATALOG, type ProviderSpec, parseServedModelIds } from "@chengchenccc/ai";

/** What a provider actually serves, as opposed to what our catalog declares.
 *
 *  The declared catalog is hand-maintained, so it drifts: `deepseek-v4-flash`
 *  was published here for a while and DeepSeek never served it. `/api/models`
 *  is what the model picker shows, so it must not present a declared-but-
 *  unserved id as usable.
 *
 *  Two rules keep this honest without slowing the endpoint down:
 *  - `serves()` is synchronous and never blocks: it answers from cache and
 *    schedules a refresh when the entry is missing or stale (stale answers
 *    are served while the refresh runs, so the picker never waits).
 *  - an unknown answer (never probed, probe failed, no key) is `null`, and
 *    `null` never flips availability — "unknown" must not be reported as
 *    "unavailable". */

export type ServedModelProbe = (providerId: string) => Promise<readonly string[] | null>;

export interface ServedModelKnowledge {
  /** `true` = the provider lists it, `false` = the provider lists other ids,
   *  `null` = unknown: keep the declared answer. */
  serves(providerId: string, modelId: string): boolean | null;
  /** Ask for a refresh; never blocks, never throws. */
  refresh(providerIds: readonly string[]): void;
}

export function createServedModelKnowledge(deps: {
  probe: ServedModelProbe;
  ttlMs?: number;
  failureTtlMs?: number;
  now?: () => number;
}): ServedModelKnowledge {
  const ttlMs = deps.ttlMs ?? 10 * 60_000;
  const failureTtlMs = deps.failureTtlMs ?? 60_000;
  const now = deps.now ?? Date.now;
  const entries = new Map<string, { at: number; ids: readonly string[] | null; ttl: number }>();
  const inFlight = new Set<string>();

  const refresh = (providerIds: readonly string[]): void => {
    for (const providerId of new Set(providerIds)) {
      if (inFlight.has(providerId)) continue;
      inFlight.add(providerId);
      deps
        .probe(providerId)
        .then((ids) => {
          entries.set(providerId, { at: now(), ids, ttl: ids ? ttlMs : failureTtlMs });
        })
        .catch(() => {
          // A failed probe is "unknown", not "serves nothing".
          entries.set(providerId, { at: now(), ids: null, ttl: failureTtlMs });
        })
        .finally(() => inFlight.delete(providerId));
    }
  };

  return {
    refresh,
    serves(providerId, modelId) {
      const entry = entries.get(providerId);
      if (!entry || now() - entry.at >= entry.ttl) refresh([providerId]);
      if (!entry?.ids) return null;
      return entry.ids.includes(modelId);
    },
  };
}

/** Fold discovery into the declared answer. Discovery can only take a model
 *  AWAY (a served id we have no key for is still unusable), never add one. */
export function applyServedAvailability(
  declared: boolean | undefined,
  serves: boolean | null,
): boolean | undefined {
  if (serves === false) return false;
  return declared;
}

/** Only what the probe needs from fetch — Bun's `typeof fetch` carries a
 *  required `preconnect` that doubles in tests don't implement. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** HTTP probe: `GET <baseUrl>/models` for the providers whose specs we ship.
 *  Anything ambiguous is `null`, never "serves nothing": a provider answering
 *  in a shape we don't parse must not empty the picker. */
export function createProviderModelProbe(deps: {
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): ServedModelProbe {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  return async (providerId) => {
    const spec: ProviderSpec | undefined = BUILTIN_CATALOG.providers[providerId];
    if (!spec) return null;
    const key = deps.env[spec.apiKeyEnv];
    if (!key) return null;
    const res = await fetchImpl(`${spec.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: requestHeaders(spec, key),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);
    if (!res?.ok) return null;
    const payload: unknown = await res.json().catch(() => null);
    if (!payload) return null;
    const ids = parseServedModelIds(payload);
    return ids.length > 0 ? ids : null;
  };
}

function requestHeaders(spec: ProviderSpec, key: string): Record<string, string> {
  // Anthropic reads its key from x-api-key and version-gates the endpoint;
  // every other provider here is OpenAI-compatible and wants a bearer token.
  if (spec.api === "anthropic-messages") {
    return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${key}` };
}
