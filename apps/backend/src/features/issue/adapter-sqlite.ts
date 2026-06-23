import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../../infra/db/schema.js";
import type { IssueRow, IssueStatus } from "./entities.js";
import type { CreateIssueInput, IssuePort, UpdateIssueInput } from "./ports.js";

const toRow = (r: typeof schema.issue.$inferSelect): IssueRow => ({
  issueId: r.issueId,
  projectId: r.projectId,
  title: r.title,
  status: r.status as IssueStatus,
  threadId: r.threadId,
  description: r.description,
  priority: r.priority as IssueRow["priority"],
  estimatedCompletionAt: r.estimatedCompletionAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export function sqliteIssueAdapter(db: Database): IssuePort {
  const d = drizzle(db, { schema });

  return {
    createIssue(input: CreateIssueInput): IssueRow {
      d.insert(schema.issue).values({
        issueId: input.issueId,
        projectId: input.projectId,
        title: input.title,
        status: "draft",
        threadId: input.threadId,
        description: input.description ?? "",
        priority: input.priority ?? "P2",
        estimatedCompletionAt: input.estimatedCompletionAt ?? null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      }).run();
      return {
        ...input,
        status: "draft",
        description: input.description ?? "",
        priority: input.priority ?? "P2",
        estimatedCompletionAt: input.estimatedCompletionAt ?? null,
        updatedAt: input.createdAt,
      };
    },

    getIssue(issueId: string): IssueRow | null {
      const r = d
        .select()
        .from(schema.issue)
        .where(eq(schema.issue.issueId, issueId))
        .get();
      return r ? toRow(r) : null;
    },

    listIssues(opts?: { projectId?: string }): IssueRow[] {
      let q = d.select().from(schema.issue).orderBy(sql`created_at DESC`).$dynamic();
      if (opts?.projectId) {
        q = q.where(eq(schema.issue.projectId, opts.projectId));
      }
      return q.all().map(toRow);
    },

    setStatus(
      issueId: string,
      expectFrom: IssueStatus,
      to: IssueStatus,
      updatedAt: number,
    ): boolean {
      const { changes } = d
        .update(schema.issue)
        .set({ status: to, updatedAt })
        .where(
          and(
            eq(schema.issue.issueId, issueId),
            eq(schema.issue.status, expectFrom),
          ),
        )
        .run();
      return changes > 0;
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
      const { changes } = d
        .delete(schema.issue)
        .where(eq(schema.issue.issueId, issueId))
        .run();
      return changes > 0;
    },
  };
}
