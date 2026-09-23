/** Version discovery for `oma update` and the TUI's upgrade hint.
 *
 *  One source of truth for "what is the newest published oma": the npm
 *  registry's dist-tags. `oma update --check`, the actual update and the
 *  startup hint all ask this module, so they can never disagree about which
 *  version is current.
 *
 *  Deliberately NOT a GitHub releases lookup: the artifact tarball lives on a
 *  GitHub release, but the CLI that decides what to install is an npm package,
 *  and the two are published in lockstep — so the registry is the one place
 *  that answers for both. */

export class UpdateCheckError extends Error {}

/** The npm name this CLI is published under (apps/oh-my-agent/package.json). */
export const OMA_PACKAGE = "@chengchenccc/oh-my-agent";

/** Pinned registry origin: a user's bun may be pointed at a mirror that lags
 *  upstream, and the version we resolve here is the one we then install by
 *  exact version — a lagging mirror would resolve a version it does not have
 *  yet and the install would fail (omp #1686 is the same bug). */
export const NPM_REGISTRY = "https://registry.npmjs.org";

/** dist-tags a release may land on, best-first for ties.
 *
 *  A single `latest` is not enough: while the 0.2.0 line is in rc, `latest`
 *  still points at an older 0.1.1-rc.1 and `rc` carries the newer build — so
 *  "newest" is the highest of the channels, not the stable tag. When a real
 *  stable release ships, `latest` wins on its own. */
const RELEASE_TAGS = ["latest", "rc"] as const;

/** Default allowance for the registry round trip. Long enough for a slow link,
 *  short enough that a wedged connection cannot stall a TUI boot. */
const DEFAULT_TIMEOUT_MS = 5_000;

export interface LatestRelease {
  version: string;
  /** Which dist-tag the version came from, for the report line. */
  tag: string;
}

/** Highest version among the dist-tags we follow. Throws on a body that is not
 *  a registry manifest, so a proxy's HTML error page is never mistaken for
 *  "no newer version". */
export function parseLatestRelease(
  body: unknown,
  tags: readonly string[] = RELEASE_TAGS,
): LatestRelease {
  if (typeof body !== "object" || body === null) {
    throw new UpdateCheckError("registry manifest is not an object");
  }
  const distTags = (body as { "dist-tags"?: unknown })["dist-tags"];
  if (typeof distTags !== "object" || distTags === null) {
    throw new UpdateCheckError("registry manifest has no dist-tags");
  }
  let best: LatestRelease | undefined;
  for (const tag of tags) {
    const version = (distTags as Record<string, unknown>)[tag];
    if (typeof version !== "string" || version.length === 0) continue;
    // Validate even the first candidate: it is only ever *compared* when a
    // second one shows up, so a lone junk tag would otherwise be reported as
    // the newest release.
    try {
      Bun.semver.order(version, version);
    } catch {
      throw new UpdateCheckError(`unparseable version "${version}" on dist-tag ${tag}`);
    }
    if (best === undefined) {
      best = { version, tag };
      continue;
    }
    // Strictly greater: the first tag listed wins a tie, so `latest` beats
    // `rc` when both carry the same version.
    if (Bun.semver.order(version, best.version) > 0) best = { version, tag };
  }
  if (best === undefined) {
    throw new UpdateCheckError(`registry manifest has none of: ${tags.join(", ")}`);
  }
  return best;
}

export interface LatestReleaseOptions {
  registry?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Newest published release, per the registry's dist-tags. */
export async function fetchLatestRelease(opts: LatestReleaseOptions = {}): Promise<LatestRelease> {
  const registry = (opts.registry ?? NPM_REGISTRY).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${registry}/${encodeURIComponent(OMA_PACKAGE).replace(/%40/, "@")}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    throw new UpdateCheckError(
      `cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw new UpdateCheckError(`${url} -> HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UpdateCheckError(`${url} did not return JSON`);
  }
  return parseLatestRelease(body);
}

/** Is `candidate` newer than `current`? A version that does not parse is never
 *  treated as newer: an unknown local build must not be nagged about, and an
 *  unparseable remote tag must not be offered as an update. */
export function isNewer(candidate: string, current: string): boolean {
  try {
    return Bun.semver.order(candidate, current) > 0;
  } catch {
    return false;
  }
}

/** `newerVersion` with every failure swallowed: undefined means "no update to
 *  report", covering both a newer release and an unreachable registry. Callers
 *  that must distinguish the two (the update command's error message) use
 *  `fetchLatestRelease` directly. */
export async function newerVersion(
  current: string,
  opts: LatestReleaseOptions = {},
): Promise<string | undefined> {
  try {
    const latest = await fetchLatestRelease(opts);
    return isNewer(latest.version, current) ? latest.version : undefined;
  } catch {
    return undefined;
  }
}
