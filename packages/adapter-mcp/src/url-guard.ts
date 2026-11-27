import { lookup } from "node:dns/promises";

/** Decode IPv4 embedded in IPv6 (dotted, WHATWG hex hextets like ::ffff:a9fe:a9fe,
 *  SIIT ::ffff:0:..., and NAT64 64:ff9b::...). */
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

/** True for addresses cloud metadata services answer on, plus the CGNAT range
 *  some operators serve them from. Mirrors the oma tool guard
 *  (`apps/oh-my-agent/src/core/tools/url-guard.ts`); both sides refuse the
 *  same hosts, including WHATWG hex IPv4-mapped IPv6 spellings. */
export function isMetadataHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (host === "metadata" || host === "metadata.google.internal" || host === "instance-data") {
    return true;
  }
  const target = (host.includes(":") ? decodeEmbeddedIPv4(host) : null) ?? host;
  const parts = target.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n))) {
    const [a, b] = [parts[0]!, parts[1]!];
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  return /^fe[89ab]/.test(target);
}

/** Loopback, RFC1918, link-local, ULA, multicast/reserved, and unspecified addresses. */
function isPrivateAddress(address: string): boolean {
  const bare = address
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (bare === "::1" || bare === "::") return true;
  if (/^f[cd]/i.test(bare) || /^fe[89ab]/i.test(bare) || /^ff/i.test(bare)) return true;
  const target = (bare.includes(":") ? decodeEmbeddedIPv4(bare) : null) ?? bare;
  const parts = target.split(".").map(Number);
  if (parts.length !== 4 || !parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return false;
  }
  const [a, b] = [parts[0]!, parts[1]!];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

export class UnsafeMcpUrlError extends Error {
  constructor(reason: string) {
    super(`unsafe MCP server url: ${reason}`);
    this.name = "UnsafeMcpUrlError";
  }
}

export interface SafeMcpUrlOptions {
  /** A local, single-operator deployment legitimately mounts MCP servers on
   *  loopback or the LAN (the product's own servers are 127.0.0.1). A backend
   *  that binds outside loopback must pass false: there a private target is an
   *  SSRF, not a preference. Metadata endpoints are refused either way. */
  readonly allowPrivate: boolean;
}

/** The backend/child fetches a url MCP server itself, so the url inherits its
 *  network position. Checked right before mounting, because DNS can move
 *  between saving a server and using it. */
export async function assertSafeMcpUrl(rawUrl: string, opts: SafeMcpUrlOptions): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeMcpUrlError(`not a url: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeMcpUrlError(`protocol ${parsed.protocol}`);
  }
  const hostname = parsed.hostname;
  if (isMetadataHost(hostname)) {
    throw new UnsafeMcpUrlError(`metadata host ${hostname}`);
  }
  if (!opts.allowPrivate && isPrivateAddress(hostname)) {
    throw new UnsafeMcpUrlError(`private host ${hostname}`);
  }
  const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
  if (literal) {
    return parsed;
  }
  let answers: string[];
  try {
    answers = (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    // Fail closed: an unresolvable host must never bypass SSRF IP inspection.
    throw new UnsafeMcpUrlError(`dns resolution failed: ${hostname}`);
  }
  if (answers.length === 0) {
    throw new UnsafeMcpUrlError(`dns resolution returned no addresses: ${hostname}`);
  }
  for (const address of answers) {
    if (isMetadataHost(address)) throw new UnsafeMcpUrlError(`resolves to metadata: ${hostname}`);
    if (!opts.allowPrivate && isPrivateAddress(address)) {
      throw new UnsafeMcpUrlError(`resolves to a private address: ${hostname}`);
    }
  }
  return parsed;
}
