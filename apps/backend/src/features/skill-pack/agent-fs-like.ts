// ── COPY of oma's virtual-FS interface ───────────────────────────────────
// Source of truth (historically): apps/oh-my-agent/src/core/tools/agent-fs-like.ts
//
// That oma file was DELETED in the 2026-09-10 cleanup — nothing in the runtime
// ever imported it. This copy is live (it types the skill-pack store), so it
// now has no counterpart to sync with; if a second consumer appears, promote
// it into a package rather than copying it again.

/** Virtual filesystem interface for agent tools. */
export interface AgentFsLike {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  list(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
}

/** Join path segments with "/", collapsing duplicate slashes. */
export function pjoin(...segments: string[]): string {
  return segments.join("/").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}
