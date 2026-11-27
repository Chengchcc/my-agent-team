import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

/** Agent roles supported by builtin skill scoping (matches agent config `role`). */
export type SkillRole = "front" | "worker";

export const SKILL_ROLES: readonly SkillRole[] = ["front", "worker"];

const VALID_ROLES = new Set<string>(SKILL_ROLES);

function isSkillRole(value: string): value is SkillRole {
  return VALID_ROLES.has(value);
}

/**
 * Parse optional `roles:` / `role:` frontmatter from a SKILL.md document.
 *
 * Supported forms:
 * - `roles: front` / `roles: worker` / `roles: all`
 * - `roles: [front, worker]`
 * - YAML block list:
 *     roles:
 *       - front
 *       - worker
 *
 * Omitted (or `all`) defaults to both roles so third-party and legacy skills
 * remain universally visible without edits.
 */
export function parseSkillRoles(content: string): readonly SkillRole[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return SKILL_ROLES;
  const frontmatter = match[1] ?? "";
  const lines = frontmatter.split("\n");
  const idx = lines.findIndex((line) => /^(?:roles|role):\s*/.test(line));
  if (idx < 0) return SKILL_ROLES;

  const headerLine = lines[idx] ?? "";
  const inlineRaw = headerLine.replace(/^(?:roles|role):\s*/, "").trim();
  const tokens: string[] = [];

  if (inlineRaw.length > 0) {
    const inner =
      inlineRaw.startsWith("[") && inlineRaw.endsWith("]") ? inlineRaw.slice(1, -1) : inlineRaw;
    for (const part of inner.split(",")) {
      const cleaned = part
        .trim()
        .replace(/^['"]|['"]$/g, "")
        .toLowerCase();
      if (cleaned) tokens.push(cleaned);
    }
  } else {
    for (const line of lines.slice(idx + 1)) {
      const item = /^\s+-\s+(.+)$/.exec(line);
      if (!item) {
        if (line.trim() === "") continue;
        break;
      }
      const cleaned = (item[1] ?? "")
        .trim()
        .replace(/^['"]|['"]$/g, "")
        .toLowerCase();
      if (cleaned) tokens.push(cleaned);
    }
  }

  if (tokens.includes("all")) return SKILL_ROLES;
  const parsed = SKILL_ROLES.filter((role) => tokens.includes(role));
  return parsed.length > 0 ? parsed : SKILL_ROLES;
}

/** Whether a skill directory (containing SKILL.md) applies to `role`. */
export function skillAppliesToRole(skillDir: string, role: SkillRole): boolean {
  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) return true;
  try {
    return parseSkillRoles(readFileSync(skillMd, "utf8")).includes(role);
  } catch {
    return true;
  }
}

/** Materialized role-filtered builtin directory under `<dataDir>/skill-packs/`. */
export function builtinRolePath(dataDir: string, role: SkillRole): string {
  return join(dataDir, "skill-packs", ".builtin-by-role", role);
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Materialize crash-safe role-filtered views (`front`, `worker`) from the
 * canonical builtin skills root so every harness (oma, Claude Code, pi, omp)
 * sees only the skills appropriate for that agent's role.
 */
export function materializeBuiltinRoleViews(sourceDir: string, dataDir: string): void {
  if (!existsSync(sourceDir)) return;
  const parentDir = join(dataDir, "skill-packs", ".builtin-by-role");
  mkdirSync(parentDir, { recursive: true });

  for (const role of SKILL_ROLES) {
    const target = builtinRolePath(dataDir, role);
    const staging = `${target}.staging-${process.pid}-${Date.now()}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });

    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const srcPath = join(sourceDir, entry.name);
      const destPath = join(staging, entry.name);
      if (entry.isDirectory()) {
        if (skillAppliesToRole(srcPath, role)) {
          copyDir(srcPath, destPath);
        }
      } else if (entry.name === "SKILL.md") {
        try {
          if (parseSkillRoles(readFileSync(srcPath, "utf8")).includes(role)) {
            copyFileSync(srcPath, destPath);
          }
        } catch {
          copyFileSync(srcPath, destPath);
        }
      } else {
        copyFileSync(srcPath, destPath);
      }
    }

    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  }
}

/**
 * Resolve the role-filtered builtin skills root. Materializes on demand if
 * seeding has not run yet (e.g. isolated tests), falling back to the raw dir
 * only when the source itself does not exist.
 */
export function resolveBuiltinSkillsDirForRole(
  dataDir: string,
  fallbackBuiltinDir: string,
  role: SkillRole,
): string {
  const roleDir = builtinRolePath(dataDir, role);
  if (existsSync(roleDir)) return roleDir;
  const canonicalBuiltin = join(dataDir, "skill-packs", "builtin");
  const source = existsSync(canonicalBuiltin)
    ? canonicalBuiltin
    : existsSync(fallbackBuiltinDir)
      ? fallbackBuiltinDir
      : null;
  if (source !== null) {
    materializeBuiltinRoleViews(source, dataDir);
    if (existsSync(roleDir)) return roleDir;
  }
  return fallbackBuiltinDir;
}

export { isSkillRole };
