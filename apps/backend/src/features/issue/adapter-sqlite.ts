import type { Database } from "bun:sqlite";
import type { IssueRow, IssueStatus } from "./entities.js";
import type { CreateIssueInput, IssuePort, UpdateIssueInput } from "./ports.js";

type Raw = {
  issue_id: string;
  project_id: string;
  title: string;
  status: IssueStatus;
  thread_id: string;
  description: string;
  priority: string;
  estimated_completion_at: number | null;
  created_at: number;
  updated_at: number;
};

const toRow = (r: Raw): IssueRow => ({
  issueId: r.issue_id,
  projectId: r.project_id,
  title: r.title,
  status: r.status,
  threadId: r.thread_id,
  description: r.description,
  priority: r.priority as IssueRow["priority"],
  estimatedCompletionAt: r.estimated_completion_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function sqliteIssueAdapter(db: Database): IssuePort {
  return {
    createIssue(input: CreateIssueInput): IssueRow {
      db.run(
        `INSERT INTO issue (issue_id, project_id, title, status, thread_id, description, priority, estimated_completion_at, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
        [
          input.issueId,
          input.projectId,
          input.title,
          input.threadId,
          input.description ?? "",
          input.priority ?? "P2",
          input.estimatedCompletionAt ?? null,
          input.createdAt,
          input.createdAt,
        ],
      );
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
      const r = db.query("SELECT * FROM issue WHERE issue_id = ?").get(issueId) as Raw | undefined;
      return r ? toRow(r) : null;
    },

    listIssues(opts?: { projectId?: string }): IssueRow[] {
      const rows = (
        opts?.projectId
          ? db
              .query("SELECT * FROM issue WHERE project_id = ? ORDER BY created_at DESC")
              .all(opts.projectId)
          : db.query("SELECT * FROM issue ORDER BY created_at DESC").all()
      ) as Raw[];
      return rows.map(toRow);
    },

    setStatus(
      issueId: string,
      expectFrom: IssueStatus,
      to: IssueStatus,
      updatedAt: number,
    ): boolean {
      db.run("UPDATE issue SET status = ?, updated_at = ? WHERE issue_id = ? AND status = ?", [
        to,
        updatedAt,
        issueId,
        expectFrom,
      ]);
      const { n } = db.query("SELECT changes() AS n").get() as { n: number };
      return n > 0;
    },

    updateIssue(issueId: string, patch: UpdateIssueInput, updatedAt: number): IssueRow | null {
      const sets: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any[] = [];
      if (patch.title !== undefined) {
        sets.push("title = ?");
        params.push(patch.title);
      }
      if (patch.description !== undefined) {
        sets.push("description = ?");
        params.push(patch.description);
      }
      if (patch.priority !== undefined) {
        sets.push("priority = ?");
        params.push(patch.priority);
      }
      if (patch.estimatedCompletionAt !== undefined) {
        sets.push("estimated_completion_at = ?");
        params.push(patch.estimatedCompletionAt);
      }
      if (sets.length === 0) return this.getIssue(issueId);
      sets.push("updated_at = ?");
      params.push(updatedAt);
      params.push(issueId);
      db.run(`UPDATE issue SET ${sets.join(", ")} WHERE issue_id = ?`, params);
      return this.getIssue(issueId);
    },

    deleteIssue(issueId: string): boolean {
      const { changes } = db.run("DELETE FROM issue WHERE issue_id = ?", [issueId]);
      return changes > 0;
    },
  };
}
