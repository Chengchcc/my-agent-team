/** The facts the Skills page states about a pack, each on its own. A pack can be registered and
 *  not on disk, on disk and never checked, or checked and failing: one word must not stand in for
 *  another. The audit of 2026-11-24 found "Ready 1/1" on screen while the check said the
 *  directory was missing, and both were believed. */

export interface PackRecord {
  id: string;
  /** The install record's state: pending | installing | ready | failed | syncing. */
  status: string;
}

/** One row of `GET /api/skill-packs/validate`. */
export interface PackCheck {
  id: string;
  ok: boolean;
  skills: number;
  issues: string[];
}

export type Materialized = "yes" | "no" | "installing";
export type CheckState = "not checked" | "passed" | "failed";

export interface PackFacts {
  materialized: Materialized;
  /** Who said so: the check walked the directory, the install record only claims it. */
  materializedSource: "check" | "install record";
  check: CheckState;
  checkIssues: readonly string[];
}
/** The check's own words for a pack whose directory is gone (skill-pack/service.ts). */
const MISSING_DIRECTORY = "materialized directory missing";

function fromInstallRecord(status: string): Materialized {
  if (status === "ready") return "yes";
  const inFlux = status === "pending" || status === "installing" || status === "syncing";
  if (inFlux) return "installing";
  return "no";
}

/** A pack's two independent facts. Once the check has run it decides whether the files are on
 *  disk: it is the only thing here that looked. */
export function derivePackFacts(pack: PackRecord, check: PackCheck | null): PackFacts {
  if (check === null) {
    return {
      materialized: fromInstallRecord(pack.status),
      materializedSource: "install record",
      check: "not checked",
      checkIssues: [],
    };
  }
  const directoryMissing = check.issues.some((issue) => issue === MISSING_DIRECTORY);
  return {
    materialized: directoryMissing ? "no" : "yes",
    materializedSource: "check",
    check: check.ok ? "passed" : "failed",
    checkIssues: check.issues,
  };
}

/** The commit a git pack is pinned to. The builtin pack keeps its install directory in the same
 *  field, which is a server path, not a revision to show. */
export function packRevision(installedRef: string | null | undefined): string | null {
  if (typeof installedRef !== "string") return null;
  const isCommit = /^[0-9a-f]{7,40}$/.test(installedRef);
  if (!isCommit) return null;
  return installedRef.slice(0, 8);
}

/** The first path segment a reader must neither see nor request (a dotfile, `.git`), or null
 *  when the path is fine. */
export function hiddenSegment(path: string): string | null {
  for (const segment of path.split("/")) {
    if (segment.startsWith(".")) return segment;
  }
  return null;
}

/** The directory a skill's files live in. The skills endpoint reports the SKILL.md path. */
export function skillDirOf(dir: string): string {
  const slash = dir.lastIndexOf("/");
  if (slash < 0) return "";
  return dir.slice(0, slash);
}

/** A member's pack list after the box for `packId` was set to `checked`, or null when that is
 *  already the truth. The caller sends the new list for that one member only. */
export function packIdsAfter(
  current: readonly string[],
  packId: string,
  checked: boolean,
): string[] | null {
  const has = current.includes(packId);
  if (checked === has) return null;
  if (checked) return [...current, packId];
  return current.filter((id) => id !== packId);
}

/** What a pack's sync answered when the upstream moved: the backend refuses with 409
 *  `upstream_changed` and the two revisions, and installs nothing until confirmed. */
export function upstreamChanged(error: unknown): { from: string; to: string } | null {
  if (!(error instanceof Error)) return null;
  const status = (error as { status?: unknown }).status;
  if (status !== 409) return null;
  try {
    const body = JSON.parse(error.message) as { code?: unknown; from?: unknown; to?: unknown };
    if (body.code === "upstream_changed") {
      return { from: String(body.from), to: String(body.to) };
    }
  } catch {
    return null;
  }
  return null;
}
