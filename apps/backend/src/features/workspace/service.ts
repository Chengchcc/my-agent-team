/** ADR 0077: the material of a requirement.
 *
 *  A workspace is a checkout a requirement works in — one project, one branch,
 *  never the default branch. It belongs to the REQUIREMENT (M:N), not to the
 *  agent: two requirements get two checkouts, which is what lets them run at
 *  the same time (one agent owning one copy serialized them — measured
 *  2026-11-23). The agent keeps a CAPABILITY binding to the project
 *  (`runtime_config.projects`), which decides who may be dispatched, not where
 *  the work lands.
 *
 *  A room carries a `current_requirement_id` pointer: a message advances
 *  exactly one requirement, and switching is an explicit act. Without the
 *  pointer, requirement/conversation M:N would make every message ambiguous.
 */
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import {
  conversation,
  conversationRequirement,
  requirementWorkspace,
  workspace,
} from "../../infra/db/schema.js";

export interface WorkspaceDeps {
  db: Database;
  idGen: () => string;
  /** Materialize the checkout (the project mirror's worktree). */
  materialize: (input: {
    projectId: string;
    requirementId: string;
  }) => Promise<{ path: string; branch: string; baseRef: string } | null>;
}

type WorkspaceRow = typeof schema.workspace.$inferSelect;

export interface WorkspaceRecord {
  workspaceId: string;
  projectId: string;
  path: string;
  branch: string;
  baseRef: string;
  status: "open" | "released";
}

export function createWorkspaceService(deps: WorkspaceDeps) {
  const db = drizzle(deps.db, { schema, casing: "snake_case" });
  return {
    /** The requirement's OPEN checkout for a project, or null. Read-only: a
     *  guard asks this ("is this run working in a checkout of that project?"),
     *  and a guard must never create anything. */
    findForRequirement(input: {
      requirementId: string;
      projectId: string;
    }): WorkspaceRecord | null {
      const existing = db
        .select()
        .from(requirementWorkspace)
        .innerJoin(workspace, eq(workspace.workspaceId, requirementWorkspace.workspaceId))
        .where(eq(requirementWorkspace.requirementId, input.requirementId))
        .all()
        .find(
          (row) => row.workspace.projectId === input.projectId && row.workspace.status === "open",
        );
      return existing ? toRecord(existing.workspace) : null;
    },

    /** The requirement's checkout for a project, created on first use. */
    async ensureForRequirement(input: {
      requirementId: string;
      projectId: string;
    }): Promise<WorkspaceRecord> {
      const existing = this.findForRequirement(input);
      if (existing !== null) return existing;
      const materialized = await deps.materialize(input);
      if (materialized === null) {
        throw new Error(
          `cannot open a workspace for requirement ${input.requirementId}: the project ${input.projectId} slot is occupied`,
        );
      }
      const workspaceId = deps.idGen();
      const now = Date.now();
      db.insert(workspace)
        .values({
          workspaceId,
          projectId: input.projectId,
          path: materialized.path,
          branch: materialized.branch,
          baseRef: materialized.baseRef,
          status: "open",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(requirementWorkspace)
        .values({ requirementId: input.requirementId, workspaceId, createdAt: now })
        .run();
      return { workspaceId, projectId: input.projectId, ...materialized, status: "open" };
    },

    /** The room's current requirement, or null. */
    currentRequirementOf(conversationId: string): string | null {
      const row = db
        .select()
        .from(conversation)
        .where(eq(conversation.conversationId, conversationId))
        .get();
      return row?.currentRequirementId ?? null;
    },

    /** Point a room at a requirement and record the M:N edge. */
    attachConversation(input: { conversationId: string; requirementId: string }): void {
      const now = Date.now();
      db.insert(conversationRequirement)
        .values({
          conversationId: input.conversationId,
          requirementId: input.requirementId,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
      db.update(conversation)
        .set({ currentRequirementId: input.requirementId })
        .where(eq(conversation.conversationId, input.conversationId))
        .run();
    },
  };
}

function toRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    path: row.path,
    branch: row.branch,
    baseRef: row.baseRef,
    status: row.status === "open" ? "open" : "released",
  };
}
