import { describe, expect, test } from "bun:test";
import { connect, createServer } from "node:net";
import { hostAllowed, startAllowlistProxy } from "./allowlist-proxy.js";

/** Raw CONNECT through the proxy; resolves with everything the tunnel sent
 *  after the proxy's own handshake (the target may answer in the same chunk). */
function connectThroughProxy(
  proxyUrl: string,
  authority: string,
): Promise<{ status: number; body: string }> {
  const port = Number(new URL(proxyUrl).port);
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const status = Number(buffered.slice(9, 12));
      const body = buffered.slice(headerEnd + 4);
      if (status !== 200) {
        resolve({ status, body });
        socket.destroy();
        return;
      }
      if (body.length > 0) {
        resolve({ status, body });
        socket.destroy();
      }
    });
    socket.on("error", reject);
  });
}

describe("sandbox network allowlist", () => {
  test("matches exact names and label-boundary subdomains only", () => {
    expect(hostAllowed("registry.npmjs.org", ["npmjs.org"])).toBe(true);
    expect(hostAllowed("npmjs.org", ["npmjs.org"])).toBe(true);
    // The substring trap: a host that merely ENDS with the name is not ours.
    expect(hostAllowed("evilnpmjs.org", ["npmjs.org"])).toBe(false);
    expect(hostAllowed("npmjs.org.evil.com", ["npmjs.org"])).toBe(false);
    expect(hostAllowed("registry.npmjs.org", ["pypi.org"])).toBe(false);
    expect(hostAllowed("anything.example", ["*"])).toBe(true);
  });

  test("a denied CONNECT is refused before any dial", async () => {
    const proxy = await startAllowlistProxy(["npmjs.org"]);
    try {
      const response = await connectThroughProxy(proxy.url, "files.internal:443");
      expect(response.status).toBe(403);
    } finally {
      await proxy.close();
    }
  });

  test("an allowed CONNECT tunnels to the target", async () => {
    // A throwaway TCP server stands in for the package registry.
    const target = createServer((socket) => socket.end("hello-from-target"));
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
    const address = target.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const proxy = await startAllowlistProxy(["127.0.0.1"]);
    try {
      const response = await connectThroughProxy(proxy.url, `127.0.0.1:${address.port}`);
      expect(response.status).toBe(200);
      expect(response.body).toContain("hello-from-target");
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
});
