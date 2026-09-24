import { describe, expect, test } from "bun:test";
import { spawnOmaProcess } from "./process.js";

describe("spawnOmaProcess stdout vs orphaned grandchildren", () => {
  test("iteration ends after the child exits even when a grandchild holds the pipe", async () => {
    // The trailing `sleep 30 &` inherits stdout and outlives bash: the pipe
    // never EOFs on its own. Before the orphan watch existed this loop hung
    // forever and the run stayed "running" (the zombie-run incident).
    const proc = spawnOmaProcess(
      { executable: "bash", args: ["-c", "echo first; echo second; sleep 30 &"] },
      { cwd: "/tmp", orphanGraceMs: 150 },
    );
    const lines: string[] = [];
    const outcome = await Promise.race([
      (async () => {
        for await (const line of proc.stdout) lines.push(line);
        return "ended";
      })(),
      Bun.sleep(5_000).then(() => "hung"),
    ]);
    expect(outcome).toBe("ended");
    expect(lines).toContain("first");
    expect(lines).toContain("second");
  });
});
