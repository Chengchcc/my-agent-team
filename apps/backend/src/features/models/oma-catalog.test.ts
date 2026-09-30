import { describe, expect, test } from "bun:test";
import { createOmaModelCatalog, type OmaCatalogSpawn } from "./oma-catalog.js";

const listing = JSON.stringify({
  backendKind: "oma",
  models: [
    {
      id: "fake/echo",
      displayName: "echo",
      reasoning: false,
      inputModalities: ["text"],
      contextWindow: 1000,
      maxOutputTokens: 100,
      available: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
});

function fakeSpawn(opts: { code?: number; stdout?: string } = {}) {
  const calls: Array<{ argv: string[] }> = [];
  const spawn: OmaCatalogSpawn = ({ argv }) => {
    calls.push({ argv: [...argv] });
    return {
      stdout: (async function* () {
        yield new TextEncoder().encode(opts.stdout ?? listing);
      })(),
      stderrText: async () => "boom-tail",
      exit: Promise.resolve(opts.code ?? 0),
      kill: () => {},
    };
  };
  return { spawn, calls };
}

describe("createOmaModelCatalog", () => {
  test("spawns --list-models verbatim over the launcher args, caches, re-spawns", async () => {
    const { spawn, calls } = fakeSpawn();
    const catalog = createOmaModelCatalog({ executable: "oma" }, spawn);
    const first = await catalog.list();
    expect(first.models[0]?.id).toBe("fake/echo");
    expect(calls[0]?.argv).toEqual(["oma", "--list-models"]);
    await catalog.list();
    expect(calls.length).toBe(1);
    catalog.invalidate();
    await catalog.list();
    expect(calls.length).toBe(2);
  });

  test("a non-zero exit fails with the stderr tail", async () => {
    const { spawn } = fakeSpawn({ code: 3, stdout: "" });
    const catalog = createOmaModelCatalog({ executable: "oma" }, spawn);
    await expect(catalog.list()).rejects.toThrow(/exited with code 3: boom-tail/);
  });

  test("malformed output fails loudly", async () => {
    const { spawn } = fakeSpawn({ stdout: "not-json" });
    const catalog = createOmaModelCatalog({ executable: "oma" }, spawn);
    await expect(catalog.list()).rejects.toThrow(/malformed --list-models output/);
  });
});
