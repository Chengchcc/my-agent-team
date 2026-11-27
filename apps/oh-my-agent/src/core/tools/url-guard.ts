import { lookup } from "node:dns/promises";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "[::]",
  "169.254.169.254",
]);

/** Decode an IPv4 address embedded inside an IPv6 literal:
 *  - IPv4-mapped (`::ffff:a.b.c.d` or WHATWG hex `::ffff:7f00:1`)
 *  - SIIT (`::ffff:0:a.b.c.d` or hex `::ffff:0:7f00:1`)
 *  - NAT64 (`64:ff9b::a.b.c.d` or hex `64:ff9b::7f00:1`)
 *  Returns dotted IPv4 or null when not an embedded-IPv4 form. */
function decodeEmbeddedIPv4(bareIpv6: string): string | null {
  const lower = bareIpv6.toLowerCase();
  const dotted = /^(?:::ffff:(?:0:)?|0:0:0:0:0:ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(
    lower,
  );
  if (dotted) return dotted[1]!;

  const hex = /^(?:::ffff:(?:0:)?|0:0:0:0:0:ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(
    lower,
  );
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True when an IPv4 dotted string falls in a non-routable/sensitive range:
 *  loopback, private (RFC1918), this-network, link-local, CGNAT (100.64/10),
 *  benchmarking (198.18/15), 0.0.0.0/8, and multicast/reserved (224.0.0.0/3). */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = [parts[0]!, parts[1]!];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIP(hostname: string): boolean {
  // Trailing-dot and case forms ("localhost.", "LOCALHOST", "*.localhost") dodge set lookup.
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (BLOCKED_HOSTS.has(host) || host === "localhost" || host.endsWith(".localhost")) return true;
  // IPv6 (WHATWG URL brackets it): unspecified ::, loopback ::1, ULA fc00::/7,
  // link-local fe80::/10, multicast ff00::/8, and embedded-IPv4 forms.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.includes(":")) {
    const embedded = decodeEmbeddedIPv4(bare);
    if (embedded) return isBlockedIPv4(embedded);
    return (
      bare === "::" ||
      bare === "::1" ||
      /^f[cd]/.test(bare) ||
      /^fe[89ab]/.test(bare) ||
      /^ff/.test(bare)
    );
  }
  return isBlockedIPv4(host);
}

export class UrlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlGuardError";
  }
}

/** Parse a URL and require an http(s) scheme. The scheme rule is
 *  policy-independent: `file:` and `data:`-style targets are refused by every
 *  caller regardless of how permissive its host policy is (a `file:` URL would
 *  be a filesystem read outside the workspace, through the browser). */
export function parseHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UrlGuardError(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlGuardError(`Blocked protocol: ${parsed.protocol}`);
  }
  return parsed;
}

/** Validate URL is safe to fetch. Throws UrlGuardError if not. */
export function assertSafeUrl(rawUrl: string): URL {
  return assertSafeUrlSync(rawUrl);
}

function assertSafeUrlSync(rawUrl: string): URL {
  const parsed = parseHttpUrl(rawUrl);
  if (isPrivateIP(parsed.hostname)) {
    throw new UrlGuardError(`Blocked host: ${parsed.hostname}`);
  }
  return parsed;
}

/** True for the addresses cloud metadata services answer on, plus the
 *  carrier-grade NAT range (100.64/10) some operators serve it from. This is
 *  the part of the private space that is NOT merely "the local network": a
 *  permissive local-dev policy must still refuse it, or the escape hatch
 *  becomes a credential-stealing primitive. */
export function isMetadataHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (host === "metadata" || host === "metadata.google.internal" || host === "instance-data") {
    return true;
  }
  // Handle dotted, WHATWG hex IPv4-mapped (::ffff:a9fe:a9fe), SIIT, and NAT64 forms.
  const target = (host.includes(":") ? decodeEmbeddedIPv4(host) : null) ?? host;
  const parts = target.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n))) {
    const [a, b] = [parts[0]!, parts[1]!];
    if (a === 169 && b === 254) return true; // link-local (AWS/GCP/Azure)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT + Alibaba metadata
    return false;
  }
  // IPv6 link-local.
  return /^fe[89ab]/.test(target);
}

/** All addresses a hostname resolves to ([] when it does not resolve — the
 *  caller surfaces the real error). Shared by the deep guard and the browser
 *  local-network policy, so both vet the same DNS answers. */
export async function resolveHostAddresses(hostname: string): Promise<string[]> {
  try {
    return (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    return [];
  }
}

/** Best-effort DNS containment: resolves the hostname and rejects when any
 *  answer lands in a blocked range (nip.io / rebinding-style pivots). Not
 *  TOCTOU-proof — the fetch re-resolves independently — but it closes the
 *  trivial "hostname is 127.0.0.1 via DNS" bypass. */
export async function assertSafeUrlDeep(rawUrl: string): Promise<URL> {
  const parsed = assertSafeUrlSync(rawUrl);
  if (parsed.hostname.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname)) {
    return parsed; // literal IP or IPv6 — already vetted by isPrivateIP
  }
  for (const address of await resolveHostAddresses(parsed.hostname)) {
    if (isPrivateIP(address)) {
      throw new UrlGuardError(`Blocked host (resolves to private address): ${parsed.hostname}`);
    }
  }
  return parsed;
}

/** Max redirect count for fetch safety */
export const MAX_REDIRECTS = 5;
/** Fetch timeout in ms */
export const FETCH_TIMEOUT_MS = 10_000;
