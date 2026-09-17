import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseGateway } from "./doctor.js";

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
