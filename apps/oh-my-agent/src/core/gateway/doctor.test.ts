import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      });
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
