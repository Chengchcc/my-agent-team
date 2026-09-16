import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseStackManifest, type StackComponent } from "./manifest.js";
import { resolveOmaBin, StackStartError, startStack } from "./supervisor.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeStack(components: unknown[], files: Record<string, string>): string {
  const root = tempDir("oma-stack-");
  writeFileSync(
    join(root, "stack.json"),
    JSON.stringify({ schemaVersion: 1, name: "test-stack", version: "1.0.0", components }),
  );
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

/** A port nothing is listening on: bind 0, read what the kernel gave, release. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

async function fetchFails(url: string): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(url);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("startStack", () => {
  test("gates on health, prefixes child logs, and stops what it started", async () => {
    const port = freePort();
    const root = writeStack(
      [
        {
          name: "alpha",
          runtime: "bun",
          cwd: "svc",
          entry: "alpha.js",
          port,
          healthUrl: `http://127.0.0.1:${port}/`,
          env: { PORT: String(port) },
        },
      ],
      {
        "svc/alpha.js":
          'Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("ok") });\nconsole.log("alpha up");\n',
      },
    );
    const home = tempDir("oma-home-");
    const logs: string[] = [];
    try {
      const handle = await startStack({
        dir: root,
        home,
        log: (line) => logs.push(line),
        healthTimeoutMs: 15_000,
      });
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");

      // Log pumping is asynchronous: poll for the line instead of assuming a tick.
      let seen = false;
      for (let i = 0; i < 50 && !seen; i++) {
        seen = logs.some((line) => line.includes("[alpha] alpha up"));
        if (!seen) await new Promise((r) => setTimeout(r, 100));
      }
      expect(seen).toBe(true);

      await handle.stop();
      expect(await handle.done).toBe(0);
      expect(await fetchFails(`http://127.0.0.1:${port}/`)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("a component that dies on its own settles the stack with its code", async () => {
    const root = writeStack([{ name: "beta", runtime: "bun", cwd: "svc", entry: "beta.js" }], {
      "svc/beta.js": 'console.log("beta up");\nsetTimeout(() => process.exit(3), 200);\n',
    });
    const home = tempDir("oma-home-");
    try {
      const handle = await startStack({ dir: root, home, log: () => {} });
      const code = await Promise.race([
        handle.done,
        new Promise<number>((r) => {
          setTimeout(() => r(-1), 15_000);
        }),
      ]);
      expect(code).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("refuses to start when the artifact has no manifest", async () => {
    const root = tempDir("oma-empty-");
    const home = tempDir("oma-home-");
    try {
      await expect(startStack({ dir: root, home, log: () => {} })).rejects.toThrow(StackStartError);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveOmaBin", () => {
  const distCli = resolve(import.meta.dirname, "../../../dist/cli.js");

  test.skipIf(!existsSync(distCli))("resolves an executable JS entry, never the runtime", () => {
    const bin = resolveOmaBin();
    expect(/\.(js|mjs|ts)$/.test(bin)).toBe(true);
    expect(bin.endsWith("bun")).toBe(false);
  });
});

describe("component parsing used by the supervisor", () => {
  test("a component without dependsOn is standalone", () => {
    const manifest = parseStackManifest({
      schemaVersion: 1,
      name: "t",
      version: "1.0.0",
      components: [{ name: "a", runtime: "bun", cwd: "a", entry: "m.js" }],
    });
    const component: StackComponent = manifest.components[0]!;
    expect(component.dependsOn).toEqual([]);
  });
});
