import type { Database } from "bun:sqlite";
import type { IssueRow, IssueStatus } from "./entities.js";
import type { CreateIssueInput, IssuePort } from "./ports.js";

type Raw = {
  issue_id: string;
  project_id: string;
  title: string;
  status: IssueStatus;
  thread_id: string;
  created_at: number;
  updated_at: number;
};

const toRow = (r: Raw): IssueRow => ({
  issueId: r.issue_id,
  projectId: r.project_id,
  title: r.title,
  status: r.status,
  threadId: r.thread_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function sqliteIssueAdapter(db: Database): IssuePort {
  return {
    createIssue(input: CreateIssueInput): IssueRow {
      db.run(
        `INSERT INTO issue (issue_id, project_id, title, status, thread_id, created_at, updated_at)
         VALUES (?, ?, ?, 'planned', ?, ?, ?)`,
        [
          input.issueId,
          input.projectId,
          input.title,
          input.threadId,
          input.createdAt,
          input.createdAt,
        ],
      );
      return { ...input, status: "planned", updatedAt: input.createdAt };
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
  };
}
