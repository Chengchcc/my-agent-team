import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";

/** Is `host` allowed? Exact name or a subdomain of an allowlisted one.
 *
 *  Suffix matching must be on a LABEL boundary: "evilnpmjs.org" is not a
 *  subdomain of "npmjs.org", and a substring check would say it is. `*` allows
 *  everything (the setting's escape hatch, not the default). */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return allow.some((entry) => {
    const a = entry.trim().toLowerCase().replace(/\.$/, "");
    if (a === "") return false;
    if (a === "*") return true;
    return h === a || h.endsWith(`.${a}`);
  });
}

export interface AllowlistProxy {
  /** `http://127.0.0.1:<port>` — hand this to children as HTTP(S)_PROXY. */
  readonly url: string;
  close(): Promise<void>;
}

const BLOCKED = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/** A cooperative HTTP(S) allowlist proxy.
 *
 *  The OS sandbox can only cut the network entirely (`--unshare-net`) or leave
 *  it open; an unprivileged bwrap cannot build "only these hosts are
 *  reachable". So this is the middle tier, and it is ADVISORY: npm/pip/curl/git
 *  honour the proxy env vars, a script that ignores them still has the network.
 *  It exists to stop accidental egress from assistant-run commands (installing
 *  from a rogue registry, posting a token somewhere), not to contain a hostile
 *  program - that needs a privileged deployment (nftables per uid/cgroup). */
export async function startAllowlistProxy(
  allow: readonly string[],
  bindHost = "127.0.0.1",
): Promise<AllowlistProxy> {
  const server = createServer((req, res) => {
    // Plain HTTP through a proxy arrives in absolute form: GET http://host/path.
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.statusCode = 400;
      res.end("absolute-form request expected");
      return;
    }
    if (!hostAllowed(target.hostname, allow)) {
      res.statusCode = 403;
      res.end(`blocked by sandbox allowlist: ${target.hostname}`);
      return;
    }
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      res.statusCode = 502;
      res.end(`upstream failed: ${err.message}`);
    });
    req.pipe(upstream);
  });

  server.on("connect", (req, socket, head) => {
    // CONNECT host:port — HTTPS tunnels. No path to inspect, so the host is the
    // whole decision.
    const authority = req.url ?? "";
    const separator = authority.lastIndexOf(":");
    const host = separator > 0 ? authority.slice(0, separator) : authority;
    if (!hostAllowed(host, allow)) {
      socket.end(BLOCKED);
      return;
    }
    const port = separator > 0 ? Number(authority.slice(separator + 1)) : 443;
    const upstream = netConnect(port, host.replace(/^\[|\]$/g, ""), () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindHost, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("allowlist proxy did not bind a port");
  }
  return {
    url: `http://${bindHost}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
