import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSkillIndex,
  GatewaySecretsError,
  readAgentStatus,
  readGatewaySecrets,
  updateGatewaySecrets,
  writeAgentStatus,
} from "./index.js";

const dirs: string[] = [];
function makeTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("@chengchenccc/config shared primitives (Phase 3)", () => {
  test("gateway-secrets updates atomically (0600), preserves keys, and refuses corrupt JSON instead of wiping", () => {
    const dir = makeTmp("cfg-sec-");
    const file = join(dir, "gateway-secrets.json");

    updateGatewaySecrets(file, (cur) => ({ ...cur, BACKEND_AUTH_TOKEN: "tok-1" }));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    updateGatewaySecrets(file, (cur) => ({ ...cur, mcpEncryptionKey: "key-1" }));
    expect(readGatewaySecrets(file)).toEqual({
      BACKEND_AUTH_TOKEN: "tok-1",
      mcpEncryptionKey: "key-1",
    });

    // Corrupt / half-written JSON MUST throw instead of silently overwriting with {}
    writeFileSync(file, "{corrupt json", "utf8");
    expect(() => readGatewaySecrets(file)).toThrow(GatewaySecretsError);
    expect(() => updateGatewaySecrets(file, (cur) => ({ ...cur, newKey: "x" }))).toThrow(
      GatewaySecretsError,
    );
    expect(readFileSync(file, "utf8")).toBe("{corrupt json");
  });

  test("buildSkillIndex resolves first-wins and parses hide + user_invocable frontmatter", () => {
    const proj = makeTmp("cfg-sk-proj-");
    const user = makeTmp("cfg-sk-user-");
    mkdirSync(join(proj, "dup"), { recursive: true });
    mkdirSync(join(user, "dup"), { recursive: true });
    mkdirSync(join(user, "hidden"), { recursive: true });
    writeFileSync(
      join(proj, "dup", "SKILL.md"),
      "---\nname: dup\ndescription: project copy\n---\nbody",
    );
    writeFileSync(
      join(user, "dup", "SKILL.md"),
      "---\nname: dup\ndescription: user copy\n---\nbody",
    );
    writeFileSync(
      join(user, "hidden", "SKILL.md"),
      "---\nname: hidden\ndescription: hidden skill\nhide: true\nuser_invocable: false\n---\nbody",
    );

    const index = buildSkillIndex([proj, user]);
    expect(index.find((s) => s.name === "dup")?.description).toBe("project copy");
    const hidden = index.find((s) => s.name === "hidden");
    expect(hidden?.hide).toBe(true);
    expect(hidden?.userInvocable).toBe(false);
  });

  test("agent-status writes atomically and honors staleness", () => {
    const ws = makeTmp("cfg-status-");
    writeAgentStatus(ws, "working", "s-1");
    const read = readAgentStatus(ws);
    expect(read?.state).toBe("working");
    expect(read?.sessionId).toBe("s-1");
  });
});
