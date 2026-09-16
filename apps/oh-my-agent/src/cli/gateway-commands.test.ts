import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGatewayDown, runGatewayFetch, runGatewayStatus } from "./gateway-commands.js";

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
      const code = await runGatewayFetch({ home, log: (line) => logs.push(line) });
      expect(code).toBe(0);
      // The guard resolves the package root from THIS file's depth (src/cli).
      // When that arithmetic is wrong the guard silently becomes a no-op, so
      // assert the skip message and the absence of any download.
      expect(logs.join("\n")).toContain("source checkout");
      expect(existsSync(join(home, "gateway"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.npm_lifecycle_event;
      else process.env.npm_lifecycle_event = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a plain CLI call is not treated as a postinstall", async () => {
    const home = tempHome();
    const lifecycle = process.env.npm_lifecycle_event;
    const baseUrl = process.env.OMA_GATEWAY_BASE_URL;
    delete process.env.npm_lifecycle_event;
    // Point at a closed port: a fast, deterministic failure instead of talking
    // to github.com (which can hang for a minute in a sandbox).
    process.env.OMA_GATEWAY_BASE_URL = "http://127.0.0.1:9";
    try {
      const logs: string[] = [];
      const code = await runGatewayFetch({ home, log: (line) => logs.push(line) });
      expect(logs.join("\n")).not.toContain("source checkout");
      expect(code).toBe(1);
      expect(logs.join("\n")).toContain("gateway fetch failed");
    } finally {
      if (lifecycle !== undefined) process.env.npm_lifecycle_event = lifecycle;
      if (baseUrl === undefined) delete process.env.OMA_GATEWAY_BASE_URL;
      else process.env.OMA_GATEWAY_BASE_URL = baseUrl;
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("runGatewayStatus", () => {
  test("reports an empty home without mutating it", async () => {
    const home = tempHome();
    try {
      const logs: string[] = [];
      const code = await runGatewayStatus({ home, log: (line) => logs.push(line) });
      expect(code).toBe(1);
      expect(logs.join("\n")).toContain("(none installed)");
      expect(existsSync(join(home, "gateway"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runGatewayDown", () => {
  test("reports that there is nothing to stop when no pidfile exists", async () => {
    const home = tempHome();
    try {
      const logs: string[] = [];
      const code = await runGatewayDown({ home, log: (line) => logs.push(line) });
      expect(code).toBe(1);
      expect(logs.join("\n")).toContain("no pidfile");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
