import { existsSync, readFileSync } from "node:fs";
import type { PersistedTerminal, TerminalKind } from "./terminal-registry.js";

/** Membership snapshot for boot restore. The file is a HINT, never truth:
 *  a corrupt/stale file drops entries; agents/projects that vanished since
 *  the last run are skipped (and pruned on the next persist). */

const KINDS: readonly TerminalKind[] = ["shell", "oma"];

function isPersisted(value: unknown): value is PersistedTerminal {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.terminalId === "string" &&
    v.terminalId.length > 0 &&
    (v.projectId === null || typeof v.projectId === "string") &&
    typeof v.agentId === "string" &&
    typeof v.cwd === "string" &&
    typeof v.title === "string" &&
    typeof v.kind === "string" &&
    KINDS.includes(v.kind as TerminalKind)
  );
}
export function loadPersistedTerminals(file: string): PersistedTerminal[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPersisted);
  } catch {
    return [];
  }
}
