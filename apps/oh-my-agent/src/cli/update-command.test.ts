import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayPaths, omaVersion } from "../core/gateway/artifact.js";
import { daemonPaths } from "../core/gateway/daemon.js";
import { bunGlobalRoot, detectInstallOwner, runUpdateCommand } from "./update-command.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "oma-update-home-"));
}

/** Install a version locally the way `fetch` would: the marker + manifest are
 *  what make it "installed", and `current` is what status/logic read. */
function fakeInstall(home: string, version: string, opts: { current?: boolean } = {}): void {
  const dir = join(gatewayPaths(home).versions, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "gateway.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "t",
      version,
      components: [{ name: "backend", runtime: "bun", cwd: "backend", entry: "main.js" }],
    }),
  );
  writeFileSync(join(dir, ".complete"), "{}\n");
  if (opts.current !== false) {
    mkdirSync(gatewayPaths(home).root, { recursive: true });
    writeFileSync(gatewayPaths(home).current, `${version}\n`);
  }
}

/** Collect the reported lines instead of printing them. */
function recorder(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

describe("runUpdateCommand --check", () => {
  test("fresh home: the artifact is missing, so an update is available (exit 1)", async () => {
    const home = tempHome();
    const out = recorder();
    try {
      const code = await runUpdateCommand({
        home,
        check: true,
        log: out.log,
        fetchLatest: async () => ({ version: "0.2.0-rc.4", tag: "rc" }),
      });
      expect(code).toBe(1);
      const text = out.lines.join("\n");
      expect(text).toContain("newest published:  0.2.0-rc.4");
      expect(text).toContain("none installed");
      expect(text).toContain("oma update` to install it");
      // A check mutates nothing.
      expect(existsSync(gatewayPaths(home).versions)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("both axes current: up to date (exit 0)", async () => {
    const home = tempHome();
    const out = recorder();
    try {
      const cli = omaVersion();
      fakeInstall(home, cli);
      const code = await runUpdateCommand({
        home,
        check: true,
        log: out.log,
        fetchLatest: async () => ({ version: cli, tag: "rc" }),
      });
      expect(code).toBe(0);
      expect(out.lines.join("\n")).toContain("up to date");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a stale artifact counts as behind even when the CLI is current", async () => {
    // This is the shape that shipped a broken gateway: CLI up to date, artifact
    // (the half that actually runs) not.
    const home = tempHome();
    const out = recorder();
    try {
      const cli = omaVersion();
      // Older than the CLI, so only the artifact axis is behind.
      fakeInstall(home, "0.0.9");
      const code = await runUpdateCommand({
        home,
        check: true,
        log: out.log,
        fetchLatest: async () => ({ version: cli, tag: "rc" }),
      });
      expect(code).toBe(1);
      const text = out.lines.join("\n");
      expect(text).toContain("0.0.9");
      expect(text).toContain("update available");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an unreachable registry fails loudly, not with a silent 'up to date'", async () => {
    const home = tempHome();
    const out = recorder();
    try {
      const code = await runUpdateCommand({
        home,
        check: true,
        log: out.log,
        fetchLatest: async () => {
          throw new Error("registry down");
        },
      });
      expect(code).toBe(1);
      expect(out.lines.join("\n")).toContain("registry down");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runUpdateCommand", () => {
  test("no silent downgrade: a CLI newer than the registry stops with a reason", async () => {
    const home = tempHome();
    const out = recorder();
    try {
      let installed = false;
      const code = await runUpdateCommand({
        home,
        log: out.log,
        fetchLatest: async () => ({ version: "0.0.1", tag: "latest" }),
        runInstall: async () => {
          installed = true;
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(installed).toBe(false);
      expect(out.lines.join("\n")).toContain("newer than the newest published version");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--version pins a downgrade on purpose", async () => {
    const home = tempHome();
    const out = recorder();
    try {
      // The pinned version is already unpacked locally, so no download is
      // attempted: this test is about the guard being bypassed, nothing else.
      fakeInstall(home, "0.0.1", { current: false });
      const code = await runUpdateCommand({
        home,
        version: "0.0.1",
        log: out.log,
        // The pinned path never asks the registry.
        fetchLatest: async () => {
          throw new Error("must not be called");
        },
        runInstall: async () => 0,
      });
      expect(code).toBe(0);
      const text = out.lines.join("\n");
      expect(text).not.toContain("newer than the newest published version");
      expect(text).toContain("already installed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("installs the artifact, then reports a current CLI as current", async () => {
    const home = tempHome();
    const out = recorder();
    try {
      const cli = omaVersion();
      fakeInstall(home, cli, { current: false });
      const code = await runUpdateCommand({
        home,
        log: out.log,
        fetchLatest: async () => ({ version: cli, tag: "rc" }),
        runInstall: async () => {
          throw new Error("must not reinstall a current CLI");
        },
      });
      expect(code).toBe(0);
      const text = out.lines.join("\n");
      // Already unpacked (the marker is there) — reported, not re-downloaded.
      expect(text).toContain("already unpacked");
      expect(text).toContain(`oma CLI ${cli} is current`);
      expect(text).toContain("done. start it with: oma gateway up");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a live detached gateway on the same version is left alone", async () => {
    const home = tempHome();
    const out = recorder();
    try {
      const cli = omaVersion();
      fakeInstall(home, cli);
      // A pidfile for THIS process: alive, so the restart branch is reached —
      // and must return before signalling anything.
      mkdirSync(gatewayPaths(home).root, { recursive: true });
      writeFileSync(
        daemonPaths(home).pid,
        `${JSON.stringify({
          pid: process.pid,
          version: cli,
          startedAt: new Date().toISOString(),
          logPath: daemonPaths(home).log,
        })}\n`,
      );
      const code = await runUpdateCommand({
        home,
        log: out.log,
        fetchLatest: async () => ({ version: cli, tag: "rc" }),
        runInstall: async () => 0,
      });
      expect(code).toBe(0);
      expect(out.lines.join("\n")).toContain("already on");
      // Still us: nothing was killed.
      expect(process.pid > 0).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("detectInstallOwner", () => {
  test("a checkout is not reinstalled over", () => {
    expect(detectInstallOwner({ fromCheckout: true, version: "1.0.0" })).toEqual({
      kind: "source",
    });
  });

  test("an entry inside bun's global tree is ours", () => {
    const install = mkdtempSync(join(tmpdir(), "oma-buninstall-"));
    try {
      const root = bunGlobalRoot({ BUN_INSTALL: install });
      const entry = join(root, "@chengchenccc", "oh-my-agent", "dist", "cli.js");
      mkdirSync(join(root, "@chengchenccc", "oh-my-agent", "dist"), { recursive: true });
      writeFileSync(entry, "\n");
      expect(
        detectInstallOwner({
          fromCheckout: false,
          entry,
          env: { BUN_INSTALL: install },
          version: "0.2.0-rc.4",
        }),
      ).toEqual({ kind: "bun-global", spec: "@chengchenccc/oh-my-agent@0.2.0-rc.4" });
      // The classification follows the REAL path, so a symlinked checkout of a
      // global package is still recognised.
      expect(realpathSync(entry).startsWith(realpathSync(root))).toBe(true);
    } finally {
      rmSync(install, { recursive: true, force: true });
    }
  });

  test("an entry outside the global tree is unknown, not guessed", () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-local-"));
    try {
      const entry = join(dir, "node_modules", "@chengchenccc", "oh-my-agent", "cli.js");
      mkdirSync(join(dir, "node_modules", "@chengchenccc", "oh-my-agent"), { recursive: true });
      writeFileSync(entry, "\n");
      expect(
        detectInstallOwner({
          fromCheckout: false,
          entry,
          env: { BUN_INSTALL: join(dir, "empty-bun") },
          version: "0.2.0-rc.4",
        }),
      ).toEqual({ kind: "unknown" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no entry path at all is unknown", () => {
    expect(detectInstallOwner({ fromCheckout: false, entry: undefined, version: "1.0.0" })).toEqual(
      {
        kind: "unknown",
      },
    );
  });
});
