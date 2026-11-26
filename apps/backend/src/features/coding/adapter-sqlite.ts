import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { codingTerminal } from "../../infra/db/schema.js";
import { loadPersistedTerminals } from "./persist.js";
import type { PersistedTerminal, TerminalKind } from "./terminal-registry.js";

export interface CodingTerminalStore {
  loadAll(): PersistedTerminal[];
  saveAll(snapshot: readonly PersistedTerminal[]): void;
  importLegacyJsonIfEmpty(file: string): number;
}

/** ADR 0082 D3: SQLite persistence for Coding terminal layout & linkage,
 *  replacing the `terminals.json` snapshot file. */
export function createSqliteCodingTerminalStore(db: Database): CodingTerminalStore {
  const d = drizzle(db, { schema: { codingTerminal }, casing: "snake_case" });

  function existsIn(table: string, col: string, value: string | null | undefined): string | null {
    if (!value) return null;
    const row = db.query(`SELECT 1 FROM ${table} WHERE ${col} = ? LIMIT 1`).get(value);
    return row ? value : null;
  }

  function loadAll(): PersistedTerminal[] {
    const rows = d.select().from(codingTerminal).all();
    return rows.map((r) => ({
      terminalId: r.terminalId,
      projectId: r.projectId ?? null,
      agentId: r.agentId,
      workspaceId: r.workspaceId ?? null,
      conversationId: r.conversationId ?? null,
      requirementId: r.requirementId ?? null,
      cwd: r.cwd,
      title: r.title,
      kind: (r.kind === "oma" ? "oma" : "shell") as TerminalKind,
    }));
  }

  function saveAll(snapshot: readonly PersistedTerminal[]): void {
    const now = Date.now();
    const keepIds = new Set(snapshot.map((entry) => entry.terminalId));
    db.transaction(() => {
      const existing = d.select({ id: codingTerminal.terminalId }).from(codingTerminal).all();
      for (const row of existing) {
        if (!keepIds.has(row.id)) {
          d.delete(codingTerminal).where(eq(codingTerminal.terminalId, row.id)).run();
        }
      }
      for (const entry of snapshot) {
        const values = {
          terminalId: entry.terminalId,
          projectId: existsIn("project", "project_id", entry.projectId),
          agentId: entry.agentId,
          workspaceId: existsIn("workspace", "workspace_id", entry.workspaceId),
          conversationId: existsIn("conversation", "conversation_id", entry.conversationId),
          requirementId: existsIn("requirement", "requirement_id", entry.requirementId),
          cwd: entry.cwd,
          title: entry.title,
          kind: entry.kind,
          createdAt: now,
          updatedAt: now,
        };
        d.insert(codingTerminal)
          .values(values)
          .onConflictDoUpdate({
            target: codingTerminal.terminalId,
            set: {
              projectId: values.projectId,
              agentId: values.agentId,
              workspaceId: values.workspaceId,
              conversationId: values.conversationId,
              requirementId: values.requirementId,
              cwd: values.cwd,
              title: values.title,
              kind: values.kind,
              updatedAt: now,
            },
          })
          .run();
      }
    })();
  }

  function importLegacyJsonIfEmpty(file: string): number {
    const existing = db.query("SELECT 1 FROM coding_terminal LIMIT 1").get();
    if (existing) return 0;
    const legacy = loadPersistedTerminals(file);
    if (legacy.length === 0) return 0;
    saveAll(legacy);
    return legacy.length;
  }

  return { loadAll, saveAll, importLegacyJsonIfEmpty };
}
