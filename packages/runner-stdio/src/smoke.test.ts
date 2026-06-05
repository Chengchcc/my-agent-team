import { describe, expect, test } from "bun:test";
import { $ } from "bun";

const BIN = `${import.meta.dir}/bin.ts`;

describe("smoke: bin spawn", () => {
  test("missing AGENT_SPEC → stderr has error + exit 1", async () => {
    const result = await $`bun run ${BIN}`.env({}).nothrow().quiet();

    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("parse");
  });

  test("invalid spec JSON → NDJSON error on stdout + exit 1", async () => {
    const result = await $`bun run ${BIN}`.env({ AGENT_SPEC: "{bad json" }).nothrow().quiet();

    expect(result.exitCode).toBe(1);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("\n");
    // Should be valid NDJSON — parse the first line
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const firstLine = lines[0] ?? "";
    const event = JSON.parse(firstLine);
    expect(event.type).toBe("error");
    expect(event.payload.message).toContain("JSON");
  });

  test("schema validation failure → NDJSON error on stdout + exit 1", async () => {
    const result = await $`bun run ${BIN}`
      .env({
        AGENT_SPEC: JSON.stringify({ schemaVersion: "2", input: "hi" }),
      })
      .nothrow()
      .quiet();

    expect(result.exitCode).toBe(1);
    const stdout = result.stdout.toString();
    const lines = stdout.trim().split("\n");
    const firstLine = lines[0] ?? "";
    const event = JSON.parse(firstLine);
    expect(event.type).toBe("error");
    expect(event.payload.message).toContain("schemaVersion");
  });
});
