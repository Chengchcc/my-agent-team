import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Human-readable display names attached to read-model DTOs (ADR 0082 D5).
 *  Always optional: an entity that was deleted or has no title simply omits
 *  its label instead of fabricating one. */
export interface EntityLabels {
  agentName?: string;
  conversationTitle?: string;
  requirementTitle?: string;
  projectName?: string;
  workflowName?: string;
}

export interface EntityLabelBatchInput {
  agentIds?: Iterable<string | null | undefined>;
  conversationIds?: Iterable<string | null | undefined>;
  requirementIds?: Iterable<string | null | undefined>;
  projectIds?: Iterable<string | null | undefined>;
  workflowIds?: Iterable<string | null | undefined>;
}

export interface EntityLabelMaps {
  agents: Map<string, string>;
  conversations: Map<string, string>;
  requirements: Map<string, string>;
  projects: Map<string, string>;
  workflows: Map<string, string>;
}

export interface EntityLabelResolver {
  resolveBatch(input: EntityLabelBatchInput): EntityLabelMaps;
  labelsFor(
    ids: {
      agentId?: string | null;
      conversationId?: string | null;
      requirementId?: string | null;
      projectId?: string | null;
      workflowId?: string | null;
    },
    maps?: EntityLabelMaps,
  ): EntityLabels | undefined;
}

function uniqueNonEmpty(values?: Iterable<string | null | undefined>): string[] {
  if (!values) return [];
  const set = new Set<string>();
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) set.add(v);
  }
  return [...set];
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

const WORKFLOW_ID_SAFE = /^[A-Za-z0-9._-]+$/;

/** Shared batch entity-label lookup backed by SQLite + optional workflowDir.
 *  Performs at most one query per non-empty entity kind to avoid N+1 lookups
 *  in list endpoints (ADR 0082 D5). */
export function createEntityLabelResolver(
  db: Database,
  opts?: { workflowDir?: string },
): EntityLabelResolver {
  function readWorkflowName(workflowId: string): string | undefined {
    if (!opts?.workflowDir || !WORKFLOW_ID_SAFE.test(workflowId)) return undefined;
    const file = join(opts.workflowDir, `${workflowId}.workflow.json`);
    if (!existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { meta?: { name?: unknown } };
      return typeof parsed.meta?.name === "string" && parsed.meta.name.trim() !== ""
        ? parsed.meta.name
        : undefined;
    } catch {
      return undefined;
    }
  }

  function resolveBatch(input: EntityLabelBatchInput): EntityLabelMaps {
    const agents = new Map<string, string>();
    const conversations = new Map<string, string>();
    const requirements = new Map<string, string>();
    const projects = new Map<string, string>();
    const workflows = new Map<string, string>();

    const agentIds = uniqueNonEmpty(input.agentIds);
    if (agentIds.length > 0) {
      const rows = db
        .query(`SELECT id, config FROM agents WHERE id IN (${placeholders(agentIds.length)})`)
        .all(...agentIds) as Array<{ id: string; config: string }>;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.config) as { name?: unknown };
          if (typeof parsed.name === "string" && parsed.name.trim() !== "") {
            agents.set(row.id, parsed.name);
          }
        } catch {
          // ignore malformed config
        }
      }
    }

    const conversationIds = uniqueNonEmpty(input.conversationIds);
    if (conversationIds.length > 0) {
      const rows = db
        .query(
          `SELECT conversation_id, title FROM conversation WHERE conversation_id IN (${placeholders(conversationIds.length)})`,
        )
        .all(...conversationIds) as Array<{ conversation_id: string; title: string | null }>;
      for (const row of rows) {
        if (typeof row.title === "string" && row.title.trim() !== "") {
          conversations.set(row.conversation_id, row.title);
        }
      }
    }

    const requirementIds = uniqueNonEmpty(input.requirementIds);
    if (requirementIds.length > 0) {
      const rows = db
        .query(
          `SELECT requirement_id, title FROM requirement WHERE requirement_id IN (${placeholders(requirementIds.length)})`,
        )
        .all(...requirementIds) as Array<{ requirement_id: string; title: string }>;
      for (const row of rows) {
        if (row.title.trim() !== "") requirements.set(row.requirement_id, row.title);
      }
    }

    const projectIds = uniqueNonEmpty(input.projectIds);
    if (projectIds.length > 0) {
      const rows = db
        .query(
          `SELECT project_id, name FROM project WHERE project_id IN (${placeholders(projectIds.length)})`,
        )
        .all(...projectIds) as Array<{ project_id: string; name: string }>;
      for (const row of rows) {
        if (row.name.trim() !== "") projects.set(row.project_id, row.name);
      }
    }

    const workflowIds = uniqueNonEmpty(input.workflowIds);
    for (const id of workflowIds) {
      const name = readWorkflowName(id);
      if (name !== undefined) workflows.set(id, name);
    }

    return { agents, conversations, requirements, projects, workflows };
  }

  function labelsFor(
    ids: {
      agentId?: string | null;
      conversationId?: string | null;
      requirementId?: string | null;
      projectId?: string | null;
      workflowId?: string | null;
    },
    preloaded?: EntityLabelMaps,
  ): EntityLabels | undefined {
    const maps =
      preloaded ??
      resolveBatch({
        agentIds: ids.agentId ? [ids.agentId] : [],
        conversationIds: ids.conversationId ? [ids.conversationId] : [],
        requirementIds: ids.requirementId ? [ids.requirementId] : [],
        projectIds: ids.projectId ? [ids.projectId] : [],
        workflowIds: ids.workflowId ? [ids.workflowId] : [],
      });
    const out: EntityLabels = {};
    if (ids.agentId) {
      const name = maps.agents.get(ids.agentId);
      if (name) out.agentName = name;
    }
    if (ids.conversationId) {
      const title = maps.conversations.get(ids.conversationId);
      if (title) out.conversationTitle = title;
    }
    if (ids.requirementId) {
      const title = maps.requirements.get(ids.requirementId);
      if (title) out.requirementTitle = title;
    }
    if (ids.projectId) {
      const name = maps.projects.get(ids.projectId);
      if (name) out.projectName = name;
    }
    if (ids.workflowId) {
      const name = maps.workflows.get(ids.workflowId);
      if (name) out.workflowName = name;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  return { resolveBatch, labelsFor };
}
