/** ADR 0077: the material of a requirement.
 *
 *  A requirement's workspace is a git worktree of the project mirror on its own
 *  branch (`req/<requirementId>`). Ownership is the REQUIREMENT's: two
 *  requirements get two checkouts and cannot collide in one tree, which is what
 *  made two parallel tasks serialize (one agent, one copy, one active run).
 *
 *  Deliberately not `bun install`: a full checkout with node_modules measured
 *  1.6G (2026-11-23) against 40M for the mirror, so the install policy is
 *  separate work — a workspace starts as a plain worktree.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface RequirementWorktreeInput {
  /** The project's bare mirror (shared object store). */
  mirrorPath: string;
  /** Where requirement checkouts live: `<workspacesRoot>/<requirementId>/<projectId>`. */
  workspacesRoot: string;
  requirementId: string;
  projectId: string;
  /** Project default branch; absent falls back to the mirror's HEAD. */
  defaultBranch: string | null;
}

export interface RequirementWorktree {
  path: string;
  branch: string;
  /** Commit the checkout started from — what a review diffs against. */
  baseRef: string;
}

/** The branch a requirement commits on. One per requirement and project: a
 *  requirement that touches two projects gets two branches with the same name
 *  in two mirrors, which cannot collide. */
export function requirementBranchOf(requirementId: string): string {
  const safe = requirementId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
  return `req/${safe}`;
}

/** Ensure the requirement's checkout exists; idempotent. Returns null when the
 *  slot is occupied by something that is not this worktree (user files are
 *  never clobbered). */
export async function ensureRequirementWorktree(
  input: RequirementWorktreeInput,
): Promise<RequirementWorktree | null> {
  const branch = requirementBranchOf(input.requirementId);
  const path = join(input.workspacesRoot, input.requirementId, input.projectId);
  const listed = await Bun.$`git -C ${input.mirrorPath} worktree list --porcelain`
    .nothrow()
    .quiet()
    .text();
  if (listed.includes(path)) {
    return { path, branch, baseRef: await resolveBase(input.mirrorPath, input.defaultBranch) };
  }
  if (existsSync(path)) return null;
  mkdirSync(join(input.workspacesRoot, input.requirementId), { recursive: true });
  const target = input.defaultBranch ?? "HEAD";
  const hasBranch =
    (
      await Bun.$`git -C ${input.mirrorPath} show-ref --verify refs/heads/${branch}`
        .quiet()
        .nothrow()
    ).exitCode === 0;
  if (hasBranch) {
    await Bun.$`git -C ${input.mirrorPath} worktree add ${path} ${branch}`.quiet();
  } else {
    await Bun.$`git -C ${input.mirrorPath} worktree add -b ${branch} ${path} ${target}`.quiet();
  }
  // Same conventions the agent worktrees learned: an identity (so a commit is
  // attributable) and the run's generated files excluded (so the tree is clean
  // without stash tricks).
  await configureCheckout(path);
  return { path, branch, baseRef: await resolveBase(input.mirrorPath, input.defaultBranch) };
}

async function configureCheckout(path: string): Promise<void> {
  const name = (await Bun.$`git config --get user.name`.nothrow().quiet().text()).trim();
  const email = (await Bun.$`git config --get user.email`.nothrow().quiet().text()).trim();
  if (name !== "" && email !== "") {
    await Bun.$`git -C ${path} config user.name ${name}`.nothrow().quiet();
    await Bun.$`git -C ${path} config user.email ${email}`.nothrow().quiet();
  }
  const target = (
    await Bun.$`git -C ${path} rev-parse --git-path info/exclude`.nothrow().quiet().text()
  ).trim();
  if (target === "") return;
  const absolute = target.startsWith("/") ? target : `${path}/${target}`;
  const current = existsSync(absolute) ? await Bun.file(absolute).text() : "";
  const missing = [".mcp.json", ".oma/"].filter(
    (line) => !current.split("\n").some((existing) => existing.trim() === line),
  );
  if (missing.length === 0) return;
  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  await Bun.write(absolute, `${prefix}${missing.join("\n")}\n`);
}

async function resolveBase(mirrorPath: string, defaultBranch: string | null): Promise<string> {
  const ref = defaultBranch ?? "HEAD";
  const out = (await Bun.$`git -C ${mirrorPath} rev-parse ${ref}`.nothrow().quiet().text()).trim();
  return out === "" ? ref : out;
}
