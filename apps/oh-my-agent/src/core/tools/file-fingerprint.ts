import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Freshness fingerprints for the file tools.
 *
 *  The gate the other harnesses call "read before edit" is expressed here as a
 *  VALUE rather than a session flag: `read` reports a fingerprint of the bytes
 *  it saw, and `edit`/`write` refuse unless the caller passes that same
 *  fingerprint for the file as it is NOW. A session flag can only answer "did
 *  you ever read this path"; a fingerprint also answers "is what you read still
 *  what is on disk", which is the part that actually loses work (a formatter,
 *  another process, or a concurrent run rewriting the file between the read and
 *  the write).
 *
 *  Deliberately NOT a session-scoped store of read paths: that state would have
 *  to survive subagents (each mounts its own tool table), resume/fork, and
 *  plugin tools, and every one of those adds a lifecycle rule to get wrong.
 *  A fingerprint in the tool call has no lifecycle at all. */

/** Marks the trailer `read` appends so the value is distinguishable from file
 *  content (which is always line-number prefixed). */
const FOOTER_RE = /^\[fingerprint ([0-9a-f]{12})\]$/m;

/** 48 bits of SHA-256 over the LF-normalized text. Long enough that an
 *  accidental match across a long session is not a concern; short enough to sit
 *  in a tool result without measurably costing context. It is a change
 *  detector, not a security primitive: it authenticates nothing and an attacker
 *  who can write the file can also forge it. */
export function computeFileFingerprint(text: string): string {
  // Line-ending normalization, so a CRLF<->LF flip (git autocrlf, an editor on
  // another platform, format-on-save) is not reported as a content change: the
  // gate must trip on real edits, not on transport. Mirrors the LF normalization
  // the snapshot store applies before hashing.
  const normalized = text.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12);
}

/** The trailer `read` appends: the fingerprint of the WHOLE file, even when only
 *  a window was returned, because an edit may anchor anywhere in it. */
export function fingerprintFooter(fingerprint: string): string {
  return `\n[fingerprint ${fingerprint}]`;
}

/** Extract the fingerprint from a previous `read` result, if it carries one.
 *  Used by tests and by any caller that threads the value through. */
export function parseFingerprint(readOutput: string): string | undefined {
  return FOOTER_RE.exec(readOutput)?.[1];
}

/** Fingerprint of a file on disk, or undefined when it cannot be read (absent,
 *  a directory, unreadable). Absence is meaningful to the callers: a path with
 *  no current content cannot have a stale read of it. */
export function fingerprintFile(path: string): string | undefined {
  try {
    return computeFileFingerprint(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Shared refusal text. It deliberately never contains the CURRENT fingerprint:
 *  handing it over would turn a refusal into a one-call bypass, since the model
 *  could echo a value it was never allowed to see. The instruction is to re-read,
 *  which is the only way to obtain an honest one (omp's stale-tag message does
 *  the same: "re-read the file ... to observe the current line numbers and tag"). */
export const MISSING_FINGERPRINT_HINT =
  "call read first and pass the [fingerprint ...] value it returns as `fingerprint`";

export const STALE_FINGERPRINT_HINT = `the file changed since that read; re-read it, redo the change against the current content, and pass the new [fingerprint ...] value`;
