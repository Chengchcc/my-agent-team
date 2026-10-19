import { describe, expect, test } from "bun:test";
import { assertSafeMcpUrl, isMetadataHost, UnsafeMcpUrlError } from "./url-guard.js";

describe("mcp url guard", () => {
  test("metadata endpoints are refused even when private hosts are allowed", async () => {
    // Allowing loopback is normal for a local stack; 169.254.169.254 is never
    // a legitimate MCP server and is the credential-stealing primitive.
    await expect(
      assertSafeMcpUrl("http://169.254.169.254/latest/meta-data/", { allowPrivate: true }),
    ).rejects.toThrow(UnsafeMcpUrlError);
    await expect(
      assertSafeMcpUrl("http://100.100.100.200/", { allowPrivate: true }),
    ).rejects.toBeInstanceOf(UnsafeMcpUrlError);
    expect(isMetadataHost("metadata.google.internal")).toBe(true);
  });

  test("loopback and private targets are allowed for a local deployment", async () => {
    expect((await assertSafeMcpUrl("http://127.0.0.1:3100/mcp", { allowPrivate: true })).port).toBe(
      "3100",
    );
    expect(
      (await assertSafeMcpUrl("http://10.0.0.5:9000/sse", { allowPrivate: true })).hostname,
    ).toBe("10.0.0.5");
  });

  test("once the backend is reachable off-host, private targets are SSRF", async () => {
    await expect(
      assertSafeMcpUrl("http://127.0.0.1:3100/mcp", { allowPrivate: false }),
    ).rejects.toThrow(/private host/);
    await expect(
      assertSafeMcpUrl("http://192.168.1.10/sse", { allowPrivate: false }),
    ).rejects.toThrow(/private host/);
  });

  test("non-http protocols are refused", async () => {
    await expect(assertSafeMcpUrl("file:///etc/passwd", { allowPrivate: true })).rejects.toThrow(
      /protocol/,
    );
  });
});
