import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStatusPath, readAgentStatus, writeAgentStatus } from "./agent-status.js";

const dir = mkdtempSync(join(tmpdir(), "agent-status-"));

describe("agent-status file (P2 structured pane state)", () => {
  test("write then read round-trips", () => {
    writeAgentStatus(dir, "working", "sess-1");
    expect(readAgentStatus(dir)).toMatchObject({ state: "working", sessionId: "sess-1" });
    writeAgentStatus(dir, "blocked", "sess-1");
    expect(readAgentStatus(dir)?.state).toBe("blocked");
  });

  test("no tmp file left behind", () => {
    writeAgentStatus(dir, "idle", "s");
    expect(existsSync(join(dir, ".oma", "agent-status.json.tmp"))).toBe(false);
  });

  test("missing/corrupt/invalid files read as null", () => {
    expect(readAgentStatus(join(dir, "never"))).toBeNull();
    const file = agentStatusPath(dir);
    writeFileSync(file, "{ nope");
    expect(readAgentStatus(dir)).toBeNull();
    writeFileSync(file, JSON.stringify({ state: "sideways", ts: Date.now() }));
    expect(readAgentStatus(dir)).toBeNull();
    writeFileSync(file, JSON.stringify({ state: "working" })); // no ts
    expect(readAgentStatus(dir)).toBeNull();
  });

  test("stale entries (crashed writer) read as null", () => {
    writeFileSync(
      agentStatusPath(dir),
      JSON.stringify({ state: "working", sessionId: "s", ts: Date.now() - 10 * 60_000 }),
    );
    expect(readAgentStatus(dir)).toBeNull();
    expect(readAgentStatus(dir, 60 * 60_000)?.state).toBe("working"); // caller widens maxAge
  });

  test("writeAgentStatus never throws (best-effort contract)", () => {
    expect(() => writeAgentStatus(join(dir, "ro", "deeper"), "idle", "s")).not.toThrow();
    expect(readFileSync(agentStatusPath(dir), "utf8")).toContain("working"); // last good write intact
  });
});

rmSync(dir, { recursive: true, force: true });
