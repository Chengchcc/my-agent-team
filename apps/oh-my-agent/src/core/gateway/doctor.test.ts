import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLarkProbe, diagnoseGateway } from "./doctor.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "oma-doctor-"));
}

/** Stage a minimal installed artifact so only the model checks can fail. */
function stageArtifact(home: string, version: string): void {
  const dir = join(home, "gateway", "versions", version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "gateway.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "test-gateway",
      version,
      components: [{ name: "backend", runtime: "bun", cwd: "backend", entry: "main.js" }],
    }),
  );
  writeFileSync(join(home, "gateway", "current"), `${version}\n`);
}

describe("diagnoseGateway", () => {
  test("names the blockers of an unconfigured deployment", async () => {
    const home = tempHome();
    try {
      const checks = await diagnoseGateway({
        home,
        probeModels: async () => ({ providers: [] }),
        probeRelease: async () => undefined,
      });
      // The release host is unreachable, which the download check reports.
      expect(checks.find((check) => check.id === "download")?.ok).toBe(false);
      const failed = checks.filter((check) => !check.ok).map((check) => check.id);
      expect(failed).toContain("artifact");
      expect(failed).toContain("models");
      // Every failure carries something to do about it.
      for (const check of checks.filter((c) => !c.ok)) {
        expect(check.fix).toBeString();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("clears the artifact and model checks once both are in place", async () => {
    const home = tempHome();
    try {
      stageArtifact(home, "1.2.3");
      const checks = await diagnoseGateway({
        home,
        probeModels: async () => ({ providers: ["deepseek"] }),
        probeRelease: async () => 200,
      });
      const failed = checks.filter((check) => !check.ok).map((check) => check.id);
      expect(failed).not.toContain("artifact");
      expect(failed).not.toContain("models");
      const models = checks.find((check) => check.id === "models");
      expect(models?.detail).toContain("deepseek");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("secrets health", () => {
  test("flags a secrets file the world can read", async () => {
    const home = tempHome();
    try {
      stageArtifact(home, "1.2.3");
      const secretsPath = join(home, "gateway-secrets.json");
      writeFileSync(secretsPath, JSON.stringify({ BACKEND_AUTH_TOKEN: "token" }), { mode: 0o644 });
      chmodSync(secretsPath, 0o644);

      const checks = await diagnoseGateway({
        home,
        probeModels: async () => ({ providers: ["deepseek"] }),
        probeRelease: async () => 200,
      });
      const secrets = checks.find((check) => check.id === "secrets");
      expect(secrets?.ok).toBe(false);
      expect(secrets?.fix).toContain("chmod 600");

      chmodSync(secretsPath, 0o600);
      const relaxed = await diagnoseGateway({
        home,
        probeModels: async () => ({ providers: ["deepseek"] }),
        probeRelease: async () => 200,
      });
      expect(relaxed.find((check) => check.id === "secrets")?.ok).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("flags unreadable secret JSON instead of crashing", async () => {
    const home = tempHome();
    try {
      stageArtifact(home, "1.2.3");
      writeFileSync(join(home, "gateway-secrets.json"), "{ not json", { mode: 0o600 });
      const checks = await diagnoseGateway({
        home,
        probeModels: async () => ({ providers: ["deepseek"] }),
        probeRelease: async () => 200,
      });
      const secrets = checks.find((check) => check.id === "secrets");
      expect(secrets?.ok).toBe(false);
      expect(secrets?.detail).toContain("unreadable");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("download channel", () => {
  test("a version with no release is not a network problem", async () => {
    const home = tempHome();
    try {
      const checks = await diagnoseGateway({
        home,
        probeModels: async () => ({ providers: [] }),
        probeRelease: async () => 404,
      });
      const download = checks.find((check) => check.id === "download");
      expect(download?.ok).toBe(true);
      expect(download?.detail).toContain("has no release");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the Lark section reports, it does not configure", () => {
  const larkCheck = (checks: Awaited<ReturnType<typeof diagnoseGateway>>, id: string) =>
    checks.find((check) => check.id === id);

  test("a degraded surface names the agent and where to fix it", async () => {
    const home = tempHome();
    try {
      const checks = await diagnoseGateway({
        home,
        probeModels: async () => ({ providers: [] }),
        probeRelease: async () => undefined,
        probeLark: async () => ({
          cliVersion: "1.0.96",
          reachable: true,
          surfaces: [
            { agentId: "ag-1", agentName: "default", status: "running", lastError: null },
            {
              agentId: "ag-2",
              agentName: "reviewer",
              status: "degraded",
              lastError: "no heartbeat for 94s",
            },
          ],
        }),
      });
      expect(larkCheck(checks, "lark-cli")?.detail).toBe("lark-cli 1.0.96");
      const surface = larkCheck(checks, "lark-surface");
      expect(surface?.ok).toBe(false);
      expect(surface?.detail).toContain("1 running");
      expect(surface?.detail).toContain("reviewer (degraded: no heartbeat for 94s)");
      expect(surface?.fix).toContain("http://127.0.0.1:3001/team/ag-2?tab=lark");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("everything running is a pass, and no surface is not a failure", async () => {
    const home = tempHome();
    try {
      const running = await diagnoseGateway({
        home,
        probeModels: async () => ({ providers: [] }),
        probeRelease: async () => undefined,
        probeLark: async () => ({
          cliVersion: "1.0.96",
          reachable: true,
          surfaces: [{ agentId: "ag-1", agentName: "default", status: "running", lastError: null }],
        }),
      });
      expect(larkCheck(running, "lark-surface")?.ok).toBe(true);
      expect(larkCheck(running, "lark-surface")?.detail).toBe("1 configured, 1 running");

      const none = await diagnoseGateway({
        home,
        probeModels: async () => ({ providers: [] }),
        probeRelease: async () => undefined,
        probeLark: async () => ({ cliVersion: null, reachable: false, surfaces: [] }),
      });
      expect(larkCheck(none, "lark-surface")?.detail).toContain("backend is not answering");
      // Lark is optional: a missing CLI is reported, never a gateway failure.
      expect(larkCheck(none, "lark-cli")?.ok).toBe(true);
      expect(larkCheck(none, "lark-cli")?.detail).toContain("not found");
      expect(larkCheck(none, "lark-cli")?.fix).toContain("install lark-cli");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the default Lark probe", () => {
  test("a refused answer is 'could not look', never 'nothing configured'", async () => {
    const original = globalThis.fetch;
    const home = tempHome();
    try {
      // 401 with a JSON error body - the shape a missing gateway token gets.
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })) as typeof fetch;
      expect(await defaultLarkProbe(home)()).toMatchObject({ reachable: false, surfaces: [] });

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify([
            { surface: "lark", status: "running", agentId: "ag-1", agentName: "default" },
            { surface: "web", status: "running", agentId: "ag-1", agentName: "default" },
          ]),
          { status: 200 },
        )) as typeof fetch;
      const probe = await defaultLarkProbe(home)();
      expect(probe.reachable).toBe(true);
      expect(probe.surfaces).toEqual([
        { agentId: "ag-1", agentName: "default", status: "running", lastError: null },
      ]);
    } finally {
      globalThis.fetch = original;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
