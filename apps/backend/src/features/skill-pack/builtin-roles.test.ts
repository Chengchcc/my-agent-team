import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteSkillPackAdapter } from "./adapter-sqlite.js";
import {
  builtinRolePath,
  materializeBuiltinRoleViews,
  parseSkillRoles,
  resolveBuiltinSkillsDirForRole,
} from "./builtin-roles.js";
import { seedSkillPacks } from "./seed.js";
import { buildSkillIndex } from "./skill-index.js";

describe("parseSkillRoles", () => {
  test("defaults to both roles when omitted or set to all", () => {
    expect(parseSkillRoles("---\nname: demo\ndescription: x\n---\n")).toEqual(["front", "worker"]);
    expect(parseSkillRoles("---\nname: demo\nroles: all\n---\n")).toEqual(["front", "worker"]);
    expect(parseSkillRoles("# no frontmatter")).toEqual(["front", "worker"]);
  });

  test("parses inline scalar, inline array, and block list forms", () => {
    expect(parseSkillRoles("---\nname: a\nroles: front\n---\n")).toEqual(["front"]);
    expect(parseSkillRoles("---\nname: b\nrole: worker\n---\n")).toEqual(["worker"]);
    expect(parseSkillRoles("---\nname: c\nroles: [front, worker]\n---\n")).toEqual([
      "front",
      "worker",
    ]);
    expect(parseSkillRoles("---\nname: d\nroles:\n  - worker\n---\n")).toEqual(["worker"]);
  });

  test("falls back to both roles when only unknown tokens are declared", () => {
    expect(parseSkillRoles("---\nname: e\nroles: unknown\n---\n")).toEqual(["front", "worker"]);
  });
});

describe("role-scoped builtin skill views", () => {
  let dataDir: string;
  let sourceDir: string;

  function writeSkill(root: string, name: string, rolesLine?: string) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const lines = ["---", `name: ${name}`, `description: ${name} desc`];
    if (rolesLine) lines.push(rolesLine);
    lines.push("---", "", `# ${name}`);
    writeFileSync(join(dir, "SKILL.md"), lines.join("\n"));
  }

  beforeEach(() => {
    const id = Math.random().toString(36).slice(2, 8);
    dataDir = resolve(`/tmp/builtin-roles-test-${id}`);
    sourceDir = join(dataDir, "repo-skills");
    mkdirSync(sourceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("seedSkillPacks materializes distinct front and worker builtin views", async () => {
    writeSkill(sourceDir, "pa_only", "roles: front");
    writeSkill(sourceDir, "worker_only", "roles: worker");
    writeSkill(sourceDir, "both_explicit", "roles: [front, worker]");
    writeSkill(sourceDir, "shared_default");

    const port = sqliteSkillPackAdapter(openDb(":memory:"));
    await seedSkillPacks({ port, dataDir, builtinSkillsDir: sourceDir });

    const frontNames = buildSkillIndex([builtinRolePath(dataDir, "front")]).map((s) => s.name);
    const workerNames = buildSkillIndex([builtinRolePath(dataDir, "worker")]).map((s) => s.name);

    expect(frontNames).toEqual(["both_explicit", "pa_only", "shared_default"]);
    expect(workerNames).toEqual(["both_explicit", "shared_default", "worker_only"]);
  });

  test("seedSkillPacks backfills role views on upgrade when builtin dir already exists", async () => {
    writeSkill(sourceDir, "pa_only", "roles: front");
    writeSkill(sourceDir, "worker_only", "roles: worker");

    const port = sqliteSkillPackAdapter(openDb(":memory:"));
    await seedSkillPacks({ port, dataDir, builtinSkillsDir: sourceDir });

    // Simulate pre-upgrade deployment: builtin/ exists, .builtin-by-role/ does not.
    rmSync(join(dataDir, "skill-packs", ".builtin-by-role"), { recursive: true, force: true });
    expect(existsSync(builtinRolePath(dataDir, "front"))).toBe(false);

    await seedSkillPacks({ port, dataDir, builtinSkillsDir: sourceDir });

    expect(buildSkillIndex([builtinRolePath(dataDir, "front")]).map((s) => s.name)).toEqual([
      "pa_only",
    ]);
    expect(buildSkillIndex([builtinRolePath(dataDir, "worker")]).map((s) => s.name)).toEqual([
      "worker_only",
    ]);
  });

  test("resolveBuiltinSkillsDirForRole materializes on demand and falls back when missing", () => {
    writeSkill(sourceDir, "pa_only", "roles: front");
    writeSkill(sourceDir, "worker_only", "roles: worker");

    const resolvedFront = resolveBuiltinSkillsDirForRole(dataDir, sourceDir, "front");
    expect(resolvedFront).toBe(builtinRolePath(dataDir, "front"));
    expect(buildSkillIndex([resolvedFront]).map((s) => s.name)).toEqual(["pa_only"]);

    const missing = join(dataDir, "missing-skills");
    expect(resolveBuiltinSkillsDirForRole(join(dataDir, "empty"), missing, "worker")).toBe(missing);
  });

  test("repository skills/ directory partitions cleanly between PA (front) and Worker", () => {
    const repoSkillsDir = resolve(import.meta.dir, "../../../../../skills");
    materializeBuiltinRoleViews(repoSkillsDir, dataDir);

    const frontNames = buildSkillIndex([builtinRolePath(dataDir, "front")]).map((s) => s.name);
    const workerNames = buildSkillIndex([builtinRolePath(dataDir, "worker")]).map((s) => s.name);

    expect(frontNames).toEqual([
      "member_manage",
      "project_manage",
      "reminder_manage",
      "requirement_memory",
      "skills_about",
      "team_dispatch",
      "wiki_manage",
      "workflow_design",
    ]);
    expect(workerNames).toEqual([
      "agent_doctor",
      "agent_fanout",
      "skills_about",
      "worker_delivery",
      "workflow_design",
    ]);
  });
});
