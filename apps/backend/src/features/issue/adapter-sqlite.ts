import type { Database } from "bun:sqlite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { IssueRow, IssueStatus } from "./entities.js";
import type { CreateIssueInput, IssuePort, UpdateIssueInput } from "./ports.js";

export function sqliteIssueAdapter(db: Database): IssuePort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    createIssue(input: CreateIssueInput): IssueRow {
      const rows = d
        .insert(schema.issue)
        .values({
          issueId: input.issueId,
          projectId: input.projectId,
          title: input.title,
          status: "draft",
          sessionId: input.sessionId,
          description: input.description ?? "",
          priority: input.priority ?? "P2",
          estimatedCompletionAt: input.estimatedCompletionAt ?? null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        })
        .returning()
        .all();
      return schema.issueSelectSchema.parse(rows[0]!);
    },

    getIssue(issueId: string): IssueRow | null {
      const r = d.select().from(schema.issue).where(eq(schema.issue.issueId, issueId)).get();
      return r ? schema.issueSelectSchema.parse(r) : null;
    },

    listIssues(opts?: { projectId?: string }): IssueRow[] {
      let q = d.select().from(schema.issue).orderBy(sql`created_at DESC`).$dynamic();
      if (opts?.projectId) {
        q = q.where(eq(schema.issue.projectId, opts.projectId));
      }
      return q.all().map((r) => schema.issueSelectSchema.parse(r));
    },

    setStatus(
      issueId: string,
      expectFrom: IssueStatus,
      to: IssueStatus,
      updatedAt: number,
    ): boolean {
      const rows = d
        .update(schema.issue)
        .set({ status: to, updatedAt })
        .where(and(eq(schema.issue.issueId, issueId), eq(schema.issue.status, expectFrom)))
        .returning()
        .all();
      return rows.length > 0;
    },

    updateIssue(issueId: string, patch: UpdateIssueInput, updatedAt: number): IssueRow | null {
      const sets: Partial<typeof schema.issue.$inferInsert> = {};
      if (patch.title !== undefined) sets.title = patch.title;
      if (patch.description !== undefined) sets.description = patch.description;
      if (patch.priority !== undefined) sets.priority = patch.priority;
      if (patch.estimatedCompletionAt !== undefined) {
        sets.estimatedCompletionAt = patch.estimatedCompletionAt;
      }
      if (Object.keys(sets).length === 0) return this.getIssue(issueId);
      sets.updatedAt = updatedAt;

      d.update(schema.issue).set(sets).where(eq(schema.issue.issueId, issueId)).run();
      return this.getIssue(issueId);
    },

    deleteIssue(issueId: string): boolean {
      const rows = d
        .delete(schema.issue)
        .where(eq(schema.issue.issueId, issueId))
        .returning()
        .all();
      return rows.length > 0;
    },
  };
}
