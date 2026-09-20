import { lstatSync, mkdirSync, realpathSync, rmSync, type Stats, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../session/session-file.js";
import { buildSkillIndex } from "../tools/skills.js";

/** Managed-skills primitives for the `learn` / `manage_skill` tools (omp
 *  managed-skills port). Managed skills live isolated in
 *  `<agentDir>/managed-skills` and resolve dead-last in skill discovery, so
 *  an authored skill of the same name always shadows them. The
 *  user-authored roots are never written by this module. */

/** Hard cap on a managed SKILL.md body to keep generated skills bounded. */
const MAX_MANAGED_SKILL_BYTES = 64_000;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Resolve the isolated managed-skills directory. */
export function managedSkillsDir(): string {
  return join(agentDir(), "managed-skills");
}

/** Validate + normalize a managed-skill name. Throws on anything outside the
 *  strict allowlist so a bad name can never escape managedSkillsDir()
 *  (blocks `..`, slashes, empty, and uppercase). */
function sanitizeSkillName(raw: string): string {
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

/** Reject when the managed-skills ROOT itself is a symlink: lstat on a child
 *  follows intermediate components, so a symlinked root would let an
 *  otherwise valid name write/delete outside the isolated directory (e.g.
 *  onto authored skills). A missing root is fine (first mint). */
function assertManagedRootSafe(): void {
  let rootStat: Stats | null;
  try {
    rootStat = lstatSync(managedSkillsDir());
  } catch {
    rootStat = null;
  }
  if (rootStat?.isSymbolicLink()) {
    throw new Error(
      "The managed-skills root is a symlink; refusing to operate outside the managed directory.",
    );
  }
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
  assertManagedRootSafe();
  const dir = join(managedSkillsDir(), name);
  const file = join(dir, "SKILL.md");
  // lstat does not follow the final component: a symlinked skill dir would
  // let the write escape the isolated managed root.
  let dirStat: Stats | null = null;
  try {
    dirStat = lstatSync(dir);
  } catch {
    /* absent dir */
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
          {
            cause: err,
          },
        );
      }
      throw err;
    }
    return { path: file };
  }
  // update: the file must already exist, be a plain file (not a symlink
  // someone pointed at an authored skill), and must not share an inode with
  // a user-authored file via hard link.
  let fileStat: Stats;
  try {
    fileStat = lstatSync(file);
  } catch {
    throw new Error(`Managed skill "${name}" does not exist. Use action "create" to add it.`);
  }
  if (fileStat.isSymbolicLink()) {
    throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
  }
  if (fileStat.nlink > 1) {
    throw new Error(
      `Managed skill "${name}" SKILL.md has ${fileStat.nlink} hard links; refusing to overwrite a file that may be user-authored elsewhere.`,
    );
  }
  writeFileSync(file, content, "utf-8");
  return { path: file };
}

/** Delete a managed skill directory. Throws when it does not exist. */
export function deleteManagedSkill(name: string): void {
  const safe = sanitizeSkillName(name);
  assertManagedRootSafe();
  const dir = join(managedSkillsDir(), safe);
  // Refuse to follow a symlinked skill dir (rm would delete the target).
  let dirStat: Stats;
  try {
    dirStat = lstatSync(dir);
  } catch (err) {
    throw new Error(`Managed skill "${safe}" does not exist.`, { cause: err });
  }
  if (dirStat.isSymbolicLink()) {
    throw new Error(
      `Managed skill "${safe}" is a symlink; refusing to delete outside the managed directory.`,
    );
  }
  rmSync(dir, { recursive: true });
}

/** Parse a model-supplied `skill` argument into the write input. Returns
 *  null when the shape is wrong (missing action/name/description/body). */
export function parseSkillArg(raw: unknown): WriteManagedSkillInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const action = o.action === "update" ? "update" : o.action === "create" ? "create" : null;
  const name = typeof o.name === "string" ? o.name : "";
  const description = typeof o.description === "string" ? o.description : "";
  const body = typeof o.body === "string" ? o.body : "";
  if (!action || !name || !description || !body) return null;
  return { action, name, description, body };
}

/** Whether an authored (non-managed) skill already claims `name`. */
export function isClaimedByAuthoredSkill(name: string, roots: readonly string[]): boolean {
  let managedRoot: string | null = null;
  try {
    managedRoot = realpathSync(managedSkillsDir());
  } catch {
    managedRoot = null;
  }
  return buildSkillIndex(roots).some(
    (e) => e.name === name.trim().toLowerCase() && e.root !== managedRoot,
  );
}

/** Shared refusal message for minting under a claimed name. */
export function authoredCollisionMessage(name: string): string {
  return `an authored skill named "${name}" already exists; managed skills cannot override it — choose a different name`;
}
