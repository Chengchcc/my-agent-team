import type { Database } from "bun:sqlite";
import { count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { ProjectRow } from "./domain.js";
import type { CreateProjectRecord, ProjectPort, UpdateProjectRecord } from "./ports.js";

const toRow = (r: typeof schema.project.$inferSelect): ProjectRow => ({
  projectId: r.projectId,
  name: r.name,
  repoUrl: r.repoUrl,
  defaultBranch: r.defaultBranch,
  autoOrchestrate: r.autoOrchestrate === 1,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export function sqliteProjectAdapter(db: Database): ProjectPort {
  const d = drizzle(db, { schema });

  return {
    createProject(input: CreateProjectRecord): ProjectRow {
      d.insert(schema.project)
        .values({
          projectId: input.projectId,
          name: input.name,
          repoUrl: input.repoUrl,
          defaultBranch: input.defaultBranch,
          autoOrchestrate: input.autoOrchestrate ? 1 : 0,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        })
        .run();
      return {
        projectId: input.projectId,
        name: input.name,
        repoUrl: input.repoUrl,
        defaultBranch: input.defaultBranch,
        autoOrchestrate: input.autoOrchestrate ?? false,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
    },

    getProject(projectId: string): ProjectRow | null {
      const r = d
        .select()
        .from(schema.project)
        .where(eq(schema.project.projectId, projectId))
        .get();
      return r ? toRow(r) : null;
    },

    listProjects(): ProjectRow[] {
      const rows = d.select().from(schema.project).orderBy(sql`created_at DESC`).all();
      return rows.map(toRow);
    },

    updateProject(projectId: string, patch: UpdateProjectRecord): ProjectRow | null {
      const sets: Record<string, unknown> = {};

      if (patch.name !== undefined) sets.name = patch.name;
      if (patch.repoUrl !== undefined) sets.repoUrl = patch.repoUrl;
      if (patch.defaultBranch !== undefined) sets.defaultBranch = patch.defaultBranch;
      if (patch.autoOrchestrate !== undefined) {
        sets.autoOrchestrate = patch.autoOrchestrate ? 1 : 0;
      }

      if (Object.keys(sets).length === 0) {
        return this.getProject(projectId);
      }

      sets.updatedAt = patch.updatedAt;

      d.update(schema.project).set(sets).where(eq(schema.project.projectId, projectId)).run();

      return this.getProject(projectId);
    },

    deleteProject(projectId: string): boolean {
      const rows = d
        .delete(schema.project)
        .where(eq(schema.project.projectId, projectId))
        .returning()
        .all();
      return rows.length > 0;
    },

    countIssuesByProject(projectId: string): number {
      const r = d
        .select({ n: count() })
        .from(schema.issue)
        .where(eq(schema.issue.projectId, projectId))
        .get();
      return (r?.n ?? 0) as number;
    },
  };
}
