import type { Database } from "bun:sqlite";
import { eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BackendConfig } from "../../config.js";
import * as schema from "../../infra/db/schema.js";
import { NotFoundError, ValidationError } from "../../infra/domain-errors.js";

export type RelType = "assigns_to" | "collaborates_with";

export interface RelationshipRow {
  id: string;
  fromAgent: string;
  toAgent: string;
  relType: RelType;
  weight: number;
  instruction: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RelationshipEdge {
  from: string;
  to: string;
  relType: RelType;
}

export interface CreateRelationshipInput {
  toAgentId: string;
  relType: RelType;
  weight?: number;
  instruction?: string;
}

export interface UpdateRelationshipInput {
  weight?: number;
  instruction?: string;
}

function isValidRelType(v: string): v is RelType {
  return v === "assigns_to" || v === "collaborates_with";
}

export function createRelationshipService(db: Database, config: BackendConfig) {
  const d = drizzle(db, { schema, casing: "snake_case" });

  function rowToRelationship(r: typeof schema.agentRelationship.$inferSelect): RelationshipRow {
    return {
      id: r.id,
      fromAgent: r.fromAgent,
      toAgent: r.toAgent,
      relType: r.relType as RelType,
      weight: r.weight,
      instruction: r.instruction,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  /** List all relationships involving an agent (both directions). */
  function listForAgent(agentId: string): RelationshipRow[] {
    return d
      .select()
      .from(schema.agentRelationship)
      .where(
        or(
          eq(schema.agentRelationship.fromAgent, agentId),
          eq(schema.agentRelationship.toAgent, agentId),
        ),
      )
      .all()
      .map(rowToRelationship);
  }

  /** Get relationship edges for wake routing (only assigns_to edges among active agents). */
  function getEdges(agentIds: string[]): RelationshipEdge[] {
    if (agentIds.length === 0) return [];
    const rows = d
      .select()
      .from(schema.agentRelationship)
      .where(eq(schema.agentRelationship.relType, "assigns_to"))
      .all();
    return rows
      .filter((r) => agentIds.includes(r.fromAgent) && agentIds.includes(r.toAgent))
      .map((r) => ({ from: r.fromAgent, to: r.toAgent, relType: "assigns_to" as const }));
  }

  async function create(
    fromAgentId: string,
    input: CreateRelationshipInput,
  ): Promise<RelationshipRow> {
    if (!isValidRelType(input.relType)) {
      throw new ValidationError(`Invalid relType: ${input.relType}`);
    }
    if (fromAgentId === input.toAgentId) {
      throw new ValidationError("Cannot create relationship to self");
    }

    // Verify both agents exist
    const fromAgent = d.select().from(schema.agents).where(eq(schema.agents.id, fromAgentId)).get();
    if (!fromAgent) throw new NotFoundError("Agent", fromAgentId);
    const toAgent = d
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, input.toAgentId))
      .get();
    if (!toAgent) throw new NotFoundError("Agent", input.toAgentId);

    const now = Date.now();
    const id = `rel-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    d.insert(schema.agentRelationship)
      .values({
        id,
        fromAgent: fromAgentId,
        toAgent: input.toAgentId,
        relType: input.relType,
        weight: input.weight ?? 1.0,
        instruction: input.instruction ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    regenerateRelationshipsMd(fromAgentId, input.toAgentId);
    return rowToRelationship(
      d.select().from(schema.agentRelationship).where(eq(schema.agentRelationship.id, id)).get()!,
    );
  }

  function update(relId: string, patch: UpdateRelationshipInput): RelationshipRow {
    const existing = d
      .select()
      .from(schema.agentRelationship)
      .where(eq(schema.agentRelationship.id, relId))
      .get();
    if (!existing) throw new NotFoundError("Relationship", relId);

    const sets: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.weight !== undefined) sets.weight = patch.weight;
    if (patch.instruction !== undefined) sets.instruction = patch.instruction;

    d.update(schema.agentRelationship)
      .set(sets)
      .where(eq(schema.agentRelationship.id, relId))
      .run();
    regenerateRelationshipsMd(existing.fromAgent, existing.toAgent);
    return rowToRelationship(
      d
        .select()
        .from(schema.agentRelationship)
        .where(eq(schema.agentRelationship.id, relId))
        .get()!,
    );
  }

  function remove(relId: string): void {
    const existing = d
      .select()
      .from(schema.agentRelationship)
      .where(eq(schema.agentRelationship.id, relId))
      .get();
    if (!existing) throw new NotFoundError("Relationship", relId);
    d.delete(schema.agentRelationship).where(eq(schema.agentRelationship.id, relId)).run();
    regenerateRelationshipsMd(existing.fromAgent, existing.toAgent);
  }

  /** Generate RELATIONSHIPS.md into agent workspace so the agent can read its team structure. */
  function regenerateRelationshipsMd(...agentIds: string[]): void {
    for (const agentId of agentIds) {
      const rels = listForAgent(agentId);
      const assignsTo = rels.filter((r) => r.fromAgent === agentId && r.relType === "assigns_to");
      const assignedFrom = rels.filter((r) => r.toAgent === agentId && r.relType === "assigns_to");
      const collaborators = rels.filter((r) => r.relType === "collaborates_with");

      const lines: string[] = [
        `# Relationships for @${agentId}`,
        "",
        "Auto-generated. Read this before deciding whether to coordinate, delegate, or collaborate.",
        "",
        "## You coordinate",
        ...assignsTo.map(
          (r) => `- @${r.toAgent}${r.instruction ? `\n  - Delegate when: ${r.instruction}` : ""}`,
        ),
        assignsTo.length === 0 ? "- None" : "",
        "",
        "## Coordinators for you",
        ...assignedFrom.map(
          (r) =>
            `- @${r.fromAgent}${r.instruction ? `\n  - They may delegate when: ${r.instruction}` : ""}`,
        ),
        assignedFrom.length === 0 ? "- None" : "",
        "",
        "## Collaborators",
        ...collaborators.map((r) => {
          const other = r.fromAgent === agentId ? r.toAgent : r.fromAgent;
          return `- @${other} (weight ${r.weight.toFixed(1)})${r.instruction ? `\n  - Collaborate when: ${r.instruction}` : ""}`;
        }),
        collaborators.length === 0 ? "- None" : "",
        "",
      ];

      // Write to agent workspace
      const agent = d.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
      if (!agent) continue;
      const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
      const { join } = require("node:path") as typeof import("node:path");
      const workspaceDir = join(config.workspaceRoot, agentId, "workspace");
      try {
        mkdirSync(workspaceDir, { recursive: true });
        writeFileSync(join(workspaceDir, "RELATIONSHIPS.md"), lines.join("\n"), "utf-8");
      } catch {
        // best-effort: workspace may not exist yet
      }
    }
  }

  return {
    listForAgent,
    getEdges,
    create,
    update,
    remove,
  };
}

export type RelationshipService = ReturnType<typeof createRelationshipService>;

// ── Wake routing (pure function, testable) ──────────────────────────────────

export function selectCoordinatorID(activeAgentIds: string[], edges: RelationshipEdge[]): string[] {
  if (activeAgentIds.length <= 1) return [...activeAgentIds];
  const active = new Set(activeAgentIds);
  const hasParent = new Set<string>();
  for (const edge of edges) {
    if (active.has(edge.from) && active.has(edge.to)) {
      hasParent.add(edge.to);
    }
  }
  for (const id of activeAgentIds) {
    if (!hasParent.has(id)) return [id];
  }
  return [activeAgentIds[0]!];
}

export function selectWakeAgentIDs(
  activeAgentIds: string[],
  mentionedIds: string[],
  hasMention: boolean,
  edges: RelationshipEdge[],
): string[] {
  // 1. Mentioned agents -> only wake those that are active
  if (mentionedIds.length > 0) {
    const mentioned = new Set(mentionedIds);
    return activeAgentIds.filter((id) => mentioned.has(id));
  }
  // 2. Has @mention pattern but none matched -> suppress all
  if (hasMention) return [];
  // 3. No mention -> auto-select coordinator
  return selectCoordinatorID(activeAgentIds, edges);
}
