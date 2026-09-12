import { lstatSync, mkdirSync, readFileSync, type Stats, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../session/session-file.js";

/** Managed-skills primitives for the `learn` tool (omp managed-skills port).
 *  Managed skills live isolated in `<agentDir>/managed-skills` and resolve
 *  dead-last in skill discovery, so an authored skill of the same name always
 *  shadows them. The user-authored roots are never written by this module. */

/** Hard cap on a managed SKILL.md body to keep generated skills bounded. */
export const MAX_MANAGED_SKILL_BYTES = 64_000;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Resolve the isolated managed-skills directory. */
export function managedSkillsDir(): string {
  return join(agentDir(), "managed-skills");
}

/** Validate + normalize a managed-skill name. Throws on anything outside the
 *  strict allowlist so a bad name can never escape managedSkillsDir()
 *  (blocks `..`, slashes, empty, and uppercase). */
export function sanitizeSkillName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid skill name "${raw}". Use lowercase letters, digits, and hyphens (1-64 chars).`,
    );
  }
  return name;
}

/** Neutralize a machine-generated managed-skill description so it cannot
 *  break out of the system-prompt skill index (strip control/format chars,
 *  angle brackets, fence delimiters; collapse to one line). Applied on write
 *  so existing files are safe on read too. */
export function sanitizeManagedDescription(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[<>`]/g, "")
    .replace(/~{2,}/g, "~")
    .replace(/\s+/g, " ")
    .trim();
}

export interface WriteManagedSkillInput {
  action: "create" | "update";
  name: string;
  description: string;
  body: string;
}

/** Create or update a managed `SKILL.md`. Returns the resolved file path.
 *  create fails when the skill already exists; update fails when it does not. */
export function writeManagedSkill(input: WriteManagedSkillInput): { path: string } {
  const name = sanitizeSkillName(input.name);
  const description = sanitizeManagedDescription(input.description);
  const body = input.body.trim();
  if (!description) throw new Error(`Managed skill "${name}" needs a non-empty description.`);
  if (!body) throw new Error(`Managed skill "${name}" needs a non-empty body.`);
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_MANAGED_SKILL_BYTES) {
    throw new Error(`Managed skill is ${bytes} bytes; the limit is ${MAX_MANAGED_SKILL_BYTES}.`);
  }
  const dir = join(managedSkillsDir(), name);
  const file = join(dir, "SKILL.md");
  // lstat does not follow the final component: a symlinked skill dir would
  // let the write escape the isolated managed root.
  let dirStat: Stats | null = null;
  try {
    dirStat = lstatSync(dir);
  } catch {
    dirStat = null;
  }
  if (dirStat?.isSymbolicLink()) {
    throw new Error(
      `Managed skill "${name}" resolves through a symlink; refusing to write outside the managed directory.`,
    );
  }
  if (input.action === "create") {
    mkdirSync(dir, { recursive: true });
    try {
      // "wx": atomic create that fails if the file already exists and
      // refuses a symlinked SKILL.md.
      writeFileSync(file, content, { flag: "wx" });
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") {
        throw new Error(
          `Managed skill "${name}" already exists. Use action "update" to change it.`,
        );
      }
      throw err;
    }
    return { path: file };
  }
  // update: the file must already exist and be a plain file (not a symlink
  // someone pointed at an authored skill).
  let fileStat: Stats;
  try {
    fileStat = lstatSync(file);
  } catch {
    throw new Error(`Managed skill "${name}" does not exist. Use action "create" to add it.`);
  }
  if (fileStat.isSymbolicLink()) {
    throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
  }
  writeFileSync(file, content, "utf-8");
  return { path: file };
}

/** Read a managed skill body (frontmatter-stripped). Test helper. */
export function readManagedSkillBody(name: string): string {
  return readFileSync(join(managedSkillsDir(), sanitizeSkillName(name), "SKILL.md"), "utf-8");
}
