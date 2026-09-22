import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersistedTerminals, savePersistedTerminals } from "./persist.js";
import type { PersistedTerminal } from "./terminal-registry.js";

const dir = mkdtempSync(join(tmpdir(), "coding-persist-"));
const file = join(dir, "terminals.json");
afterEachReset();

function afterEachReset() {
  // nothing — kept for readability
}

function entry(over: Partial<PersistedTerminal> = {}): PersistedTerminal {
  return {
    terminalId: "t-1",
    projectId: "p1",
    agentId: "a1",
    cwd: dir,
    title: "bash",
    kind: "shell",
    ...over,
  };
}

describe("coding persist helpers", () => {
  test("round-trips entries", () => {
    savePersistedTerminals(file, [
      entry(),
      entry({ terminalId: "t-2", kind: "oma", title: "oma" }),
    ]);
    const loaded = loadPersistedTerminals(file);
    expect(loaded).toHaveLength(2);
    expect(loaded[1]).toMatchObject({ terminalId: "t-2", kind: "oma" });
  });

  test("missing file is empty, corrupt file drops everything, bad entries are filtered", () => {
    expect(loadPersistedTerminals(join(dir, "nope.json"))).toEqual([]);
    writeFileSync(file, "{ not json");
    expect(loadPersistedTerminals(file)).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify([
        entry(),
        { terminalId: 42 },
        { terminalId: "t-3", projectId: "p", agentId: "a", cwd: "/", title: "x", kind: "nonsense" },
        null,
      ]),
    );
    const loaded = loadPersistedTerminals(file);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.terminalId).toBe("t-1");
  });

  test("save is atomic (no .tmp leftover)", () => {
    savePersistedTerminals(file, [entry()]);
    expect(readFileSync(file, "utf8")).toContain("t-1");
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, "stale");
    savePersistedTerminals(file, [entry({ terminalId: "t-9" })]);
    expect(readFileSync(file, "utf8")).toContain("t-9");
    rmSync(tmp, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});
