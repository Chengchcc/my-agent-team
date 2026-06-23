import type { Database } from "bun:sqlite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { IssueStatus } from "../issue/entities.js";
import type { ColumnConfigRow } from "./domain.js";
import type { ColumnConfigPort, CreateColumnConfigRecord } from "./ports.js";

const toRow = (r: typeof schema.columnConfig.$inferSelect): ColumnConfigRow => ({
  configId: r.configId,
  projectId: r.projectId,
  status: r.status as IssueStatus,
  agentId: r.agentId,
  promptTemplate: r.promptTemplate,
  approvalPosture: r.approvalPosture as "auto" | "human",
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export function sqliteColumnConfigAdapter(db: Database): ColumnConfigPort {
  const d = drizzle(db, { schema });

  return {
    listByProject(projectId: string): ColumnConfigRow[] {
      // CASE-WHEN sort retained as sql`` fragment — drizzle has no native abstraction for this.
      const rows = d
        .select()
        .from(schema.columnConfig)
        .where(eq(schema.columnConfig.projectId, projectId))
        .orderBy(
          sql`CASE status
            WHEN 'planned' THEN 0
            WHEN 'in_progress' THEN 1
            WHEN 'in_review' THEN 2
            WHEN 'done' THEN 3
            ELSE 4
          END`,
        )
        .all();
      return rows.map(toRow);
    },

    getByProjectStatus(projectId: string, status: IssueStatus): ColumnConfigRow | null {
      const r = d
        .select()
        .from(schema.columnConfig)
        .where(
          and(eq(schema.columnConfig.projectId, projectId), eq(schema.columnConfig.status, status)),
        )
        .get();
      return r ? toRow(r) : null;
    },

    upsert(input: CreateColumnConfigRecord): ColumnConfigRow {
      d.insert(schema.columnConfig)
        .values({
          configId: input.configId,
          projectId: input.projectId,
          status: input.status,
          agentId: input.agentId,
          promptTemplate: input.promptTemplate,
          approvalPosture: input.approvalPosture ?? "auto",
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [schema.columnConfig.projectId, schema.columnConfig.status],
          set: {
            agentId: input.agentId,
            promptTemplate: input.promptTemplate,
            approvalPosture: input.approvalPosture ?? "auto",
            updatedAt: input.now,
          },
        })
        .run();
      return {
        configId: input.configId,
        projectId: input.projectId,
        status: input.status,
        agentId: input.agentId,
        promptTemplate: input.promptTemplate,
        approvalPosture: (input.approvalPosture ?? "auto") as "auto" | "human",
        createdAt: input.now,
        updatedAt: input.now,
      };
    },

    delete(configId: string): boolean {
      const rows = d
        .delete(schema.columnConfig)
        .where(eq(schema.columnConfig.configId, configId))
        .returning()
        .all();
      return rows.length > 0;
    },
  };
}
