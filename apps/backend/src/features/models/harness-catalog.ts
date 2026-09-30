/**
 * The harness list, and per harness the models it declares over ACP.
 *
 * Reading a harness's models costs a session: the protocol carries no static
 * catalog (see `probeHarnessCatalog` in adapter-acp, which opens one and closes
 * it). Two further facts shape this module:
 *
 *  - The bridges fetch their package on first use - measured at 43s for the
 *    claude bridge - so a caller that probes on every render would be unusable.
 *  - A harness can be installed-but-unauthenticated, or simply down. One bad
 *    harness must not blank the list for the other three.
 *
 * Hence: results are cached per harness for a TTL, concurrent callers share one
 * probe, and every failure is reported as a per-harness `error` with no models
 * rather than thrown.
 */
import type { AcpHarnessModel } from "@chengchenccc/adapter-acp";

export interface HarnessCatalogEntry {
  readonly key: string;
  readonly name: string;
  /** Models the harness declares, in its own vocabulary; empty when unknown. */
  readonly models: readonly AcpHarnessModel[];
  /** The model it would run without being asked. */
  readonly currentModel: string | null;
  /** Why there are no models, when that is the case. */
  readonly error: string | null;
}

export interface HarnessCatalogOptions {
  /** The harnesses to list, in the order the caller wants them shown. */
  readonly harnesses: () => readonly { readonly key: string; readonly name: string }[];
  /** One probe: opens a session against that harness and closes it. */
  readonly probe: (key: string) => Promise<{
    readonly models: readonly AcpHarnessModel[];
    readonly currentModel: string | null;
  }>;
  /** How long a cached answer stays usable. Default 10 minutes. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface HarnessCatalog {
  list(): Promise<HarnessCatalogEntry[]>;
  /** Drop every cached answer: a harness was installed, configured or upgraded. */
  invalidate(): void;
}

export function createHarnessCatalog(opts: HarnessCatalogOptions): HarnessCatalog {
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  const cached = new Map<string, { at: number; entry: HarnessCatalogEntry }>();
  const inFlight = new Map<string, Promise<HarnessCatalogEntry>>();

  const probeOnce = (key: string, name: string): Promise<HarnessCatalogEntry> => {
    const started = inFlight.get(key);
    if (started) return started;
    const pending = opts
      .probe(key)
      .then((found) => ({ key, name, ...found, error: null }))
      .catch((err: unknown) => ({
        key,
        name,
        models: [],
        currentModel: null,
        error: err instanceof Error ? err.message : String(err),
      }))
      .then((entry) => {
        cached.set(key, { at: now(), entry });
        inFlight.delete(key);
        return entry;
      });
    inFlight.set(key, pending);
    return pending;
  };

  return {
    async list() {
      return Promise.all(
        opts.harnesses().map(({ key, name }) => {
          const hit = cached.get(key);
          if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.entry);
          return probeOnce(key, name);
        }),
      );
    },
    invalidate() {
      cached.clear();
    },
  };
}
