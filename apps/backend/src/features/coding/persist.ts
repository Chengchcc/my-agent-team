import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
    typeof v.projectId === "string" &&
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

export function savePersistedTerminals(
  file: string,
  terminals: readonly PersistedTerminal[],
): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(terminals, null, 2)}\n`);
  renameSync(tmp, file);
}
