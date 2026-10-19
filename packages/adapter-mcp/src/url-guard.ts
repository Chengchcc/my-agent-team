import { lookup } from "node:dns/promises";

/** True for addresses cloud metadata services answer on, plus the CGNAT range
 *  some operators serve them from. Mirrors the oma tool guard
 *  (`apps/oh-my-agent/src/core/tools/url-guard.ts`); the two are duplicated on
 *  purpose - the backend may not import an app, and both sides must refuse the
 *  same hosts. */
export function isMetadataHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (host === "metadata" || host === "metadata.google.internal" || host === "instance-data") {
    return true;
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host)?.[1];
  const target = mapped ?? host;
  const parts = target.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n))) {
    const [a, b] = [parts[0]!, parts[1]!];
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  return /^fe[89ab]/.test(target);
}

/** Loopback, RFC1918, link-local, ULA and the unspecified address. */
function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (bare === "::1" || bare === "::" || bare === "0.0.0.0") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(bare)) return true; // IPv6 ULA
  if (/^fe[89ab]/i.test(bare)) return true; // IPv6 link-local
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare)?.[1];
  const target = mapped ?? bare;
  const parts = target.split(".").map(Number);
  if (parts.length !== 4 || !parts.every((n) => Number.isInteger(n))) return false;
  const [a, b] = [parts[0]!, parts[1]!];
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
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
  const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
  if (literal) {
    if (!opts.allowPrivate && isPrivateAddress(hostname)) {
      throw new UnsafeMcpUrlError(`private host ${hostname}`);
    }
    return parsed;
  }
  let answers: string[] = [];
  try {
    answers = (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    // Unresolvable: the client will surface the real error.
    return parsed;
  }
  for (const address of answers) {
    if (isMetadataHost(address)) throw new UnsafeMcpUrlError(`resolves to metadata: ${hostname}`);
    if (!opts.allowPrivate && isPrivateAddress(address)) {
      throw new UnsafeMcpUrlError(`resolves to a private address: ${hostname}`);
    }
  }
  return parsed;
}
