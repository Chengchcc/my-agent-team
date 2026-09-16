import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStackFetch, runStackStatus } from "./stack-commands.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "oma-cli-home-"));
}

describe("postinstall guard", () => {
  test("stays quiet inside the repo checkout instead of downloading", async () => {
    const home = tempHome();
    const previous = process.env.npm_lifecycle_event;
    process.env.npm_lifecycle_event = "postinstall";
    try {
      const logs: string[] = [];
      const code = await runStackFetch({ home, log: (line) => logs.push(line) });
      expect(code).toBe(0);
      // The guard resolves the package root from THIS file's depth (src/cli).
      // When that arithmetic is wrong the guard silently becomes a no-op, so
      // assert the skip message and the absence of any download.
      expect(logs.join("\n")).toContain("source checkout");
      expect(existsSync(join(home, "stack"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.npm_lifecycle_event;
      else process.env.npm_lifecycle_event = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a plain CLI call is not treated as a postinstall", async () => {
    const home = tempHome();
    const previous = process.env.npm_lifecycle_event;
    delete process.env.npm_lifecycle_event;
    try {
      const logs: string[] = [];
      // No server is reachable, so this must fail as a download — the point is
      // that it does not take the "skip" branch.
      const code = await runStackFetch({
        home,
        log: (line) => logs.push(line),
        ...{ version: "0.0.0-not-a-release" },
      });
      expect(logs.join("\n")).not.toContain("source checkout");
      expect(code).toBe(1);
      expect(logs.join("\n")).toContain("stack fetch failed");
    } finally {
      if (previous !== undefined) process.env.npm_lifecycle_event = previous;
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("runStackStatus", () => {
  test("reports an empty home without mutating it", async () => {
    const home = tempHome();
    try {
      const logs: string[] = [];
      const code = await runStackStatus({ home, log: (line) => logs.push(line) });
      expect(code).toBe(1);
      expect(logs.join("\n")).toContain("(none installed)");
      expect(existsSync(join(home, "stack"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
