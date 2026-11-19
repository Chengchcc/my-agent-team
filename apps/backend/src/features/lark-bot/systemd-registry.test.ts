import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botEnvPathOf, SystemdLarkBotRegistry, systemdUnitOf } from "./systemd-registry.js";

function harness(opts: { heartbeat?: { status: string; lastSeenAt: number } | null } = {}) {
  const calls: string[][] = [];
  const state = new Map<string, string>([["is-active", "active"]]);
  const dataDir = mkdtempSync(join(tmpdir(), "bot-unit-"));
  const registry = new SystemdLarkBotRegistry({
    dataDir,
    backendUrl: "http://127.0.0.1:3000",
    backendAuthToken: "tok",
    entryPath: "/repo/apps/lark-bot/src/main.ts",
    heartbeatOf: () => opts.heartbeat ?? null,
    now: () => 1_000_000,
    run: async (args) => {
      calls.push([...args]);
      if (args[1] === "is-active") {
        return { code: 0, stdout: `${state.get("is-active")}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return { registry, calls, dataDir, state };
}

describe("ADR 0068: the backend drives the bot's systemd unit", () => {
  test("start writes a 0600 EnvironmentFile and runs systemctl start", async () => {
    const { registry, calls, dataDir } = harness();
    await registry.ensureLarkBot("default", "oma CLI", "agent:default");

    const envPath = botEnvPathOf(dataDir, "default");
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain("LARK_BOT_AGENT_ID=default");
    expect(env).toContain("BACKEND_AUTH_TOKEN=tok");
    expect(env).toContain("LARK_BOT_DISPLAY_NAME=oma CLI");
    expect(env).toContain("LARK_BOT_PROFILE=agent:default");
    // The file carries the backend token: nobody else may read it.
    expect(statSync(envPath).mode & 0o777).toBe(0o600);

    expect(calls[0]).toEqual(["systemctl", "start", "my-agent-team-lark-bot@default.service"]);
  });

  test("an absent display name is omitted, never written as an empty value", async () => {
    const { registry, dataDir } = harness();
    await registry.ensureLarkBot("default");
    const env = readFileSync(botEnvPathOf(dataDir, "default"), "utf8");
    // "" and "absent" mean different things to the bot (group @ detection).
    expect(env).not.toContain("LARK_BOT_DISPLAY_NAME=");
  });

  test("stop runs systemctl stop and the bot stops reading as running", async () => {
    const { registry, calls } = harness();
    await registry.ensureLarkBot("default");
    await registry.stopLarkBot("default");
    expect(calls.at(-1)).toEqual(["systemctl", "stop", "my-agent-team-lark-bot@default.service"]);
    expect(registry.statusOf("default")).toBe("configured");
  });

  test("a unit name is derived from the agent id without shell metacharacters", () => {
    // The id reaches `systemctl` as one argv entry; anything outside the safe
    // set must be refused rather than escaped into a different unit.
    expect(systemdUnitOf("default")).toBe("my-agent-team-lark-bot@default.service");
    expect(() => systemdUnitOf("a b; rm -rf /")).toThrow();
  });
});

describe("ADR 0068: 'listening' comes from the heartbeat, not from the PID", () => {
  test("a fresh heartbeat decides the status", async () => {
    const beat = { status: "running", lastSeenAt: 999_000 };
    const { registry } = harness({ heartbeat: beat });
    await registry.ensureLarkBot("default");
    expect(registry.statusOf("default")).toBe("running");
  });

  test("a stale heartbeat falls back to the process state", async () => {
    const old = { status: "running", lastSeenAt: 1_000_000 - 120_000 };
    const { registry } = harness({ heartbeat: old });
    await registry.ensureLarkBot("default");
    // Process is up but has said nothing for two minutes: not "listening".
    expect(registry.statusOf("default")).toBe("configured");
  });

  test("a heartbeat reporting an error wins over a live process", async () => {
    const beat = { status: "error", lastSeenAt: 999_500 };
    const { registry } = harness({ heartbeat: beat });
    await registry.ensureLarkBot("default");
    expect(registry.statusOf("default")).toBe("error");
  });
});
