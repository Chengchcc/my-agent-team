import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileMcpServerAdapter, mcpCatalogPath } from "./adapter-file.js";

// The key lives in the launcher's secrets file, so this test owns its own home.
process.env.OMA_HOME = mkdtempSync(join(tmpdir(), "mcp-home-"));

function newCatalog(): { dataDir: string; port: ReturnType<typeof fileMcpServerAdapter> } {
  const dataDir = mkdtempSync(join(tmpdir(), "mcp-catalog-"));
  return { dataDir, port: fileMcpServerAdapter(dataDir) };
}

describe("mcp catalog at rest", () => {
  test("env and headers are ciphertext on disk, plaintext through the port", () => {
    const { dataDir, port } = newCatalog();
    port.create({
      serverId: "s1",
      name: "guarded",
      transport: "stdio",
      command: "node",
      args: "[]",
      env: JSON.stringify({ API_TOKEN: "super-secret" }),
      headers: JSON.stringify({ Authorization: "Bearer abc" }),
      url: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const onDisk = readFileSync(mcpCatalogPath(dataDir), "utf8");
    expect(onDisk).not.toContain("super-secret");
    expect(onDisk).not.toContain("Bearer abc");

    const row = port.getById("s1");
    expect(row?.env).toEqual({ API_TOKEN: "super-secret" });
    expect(row?.headers).toEqual({ Authorization: "Bearer abc" });
  });

  test("a hand-written plaintext catalog still reads, and is sealed on read", () => {
    const { dataDir, port } = newCatalog();
    // The catalog is documented as human-editable: that must keep working.
    writeFileSync(
      mcpCatalogPath(dataDir),
      JSON.stringify({
        servers: [
          {
            serverId: "hand",
            name: "hand-written",
            transport: "stdio",
            command: "node",
            args: [],
            env: { HAND_TOKEN: "typed-by-hand" },
            headers: {},
            url: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    expect(port.getById("hand")?.env).toEqual({ HAND_TOKEN: "typed-by-hand" });
    // Re-encrypted on that same read: a copied dataDir stops leaking it now,
    // not at the next edit.
    expect(readFileSync(mcpCatalogPath(dataDir), "utf8")).not.toContain("typed-by-hand");
    // ...and it still reads correctly afterwards.
    expect(port.getById("hand")?.env).toEqual({ HAND_TOKEN: "typed-by-hand" });
  });
});
