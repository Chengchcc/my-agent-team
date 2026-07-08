import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { mcpServerSelectSchema } from "../../infra/db/schema.js";
import type { McpServerRow } from "./domain.js";
import type { CreateMcpServerRecord, McpServerPort, UpdateMcpServerRecord } from "./ports.js";

export function sqliteMcpServerAdapter(db: Database): McpServerPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    create(input: CreateMcpServerRecord): McpServerRow {
      d.insert(schema.mcpServer)
        .values({
          serverId: input.serverId,
          agentId: input.agentId,
          name: input.name,
          transport: input.transport,
          command: input.command,
          args: input.args,
          env: input.env,
          url: input.url,
          enabled: input.enabled,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        })
        .run();
      return mcpServerSelectSchema.parse(
        d
          .select()
          .from(schema.mcpServer)
          .where(eq(schema.mcpServer.serverId, input.serverId))
          .get()!,
      );
    },

    listByAgent(agentId: string): McpServerRow[] {
      return d
        .select()
        .from(schema.mcpServer)
        .where(eq(schema.mcpServer.agentId, agentId))
        .all()
        .map((r) => mcpServerSelectSchema.parse(r));
    },

    getById(serverId: string): McpServerRow | null {
      const r = d
        .select()
        .from(schema.mcpServer)
        .where(eq(schema.mcpServer.serverId, serverId))
        .get();
      return r ? mcpServerSelectSchema.parse(r) : null;
    },

    update(serverId: string, patch: UpdateMcpServerRecord): McpServerRow | null {
      const sets: Record<string, unknown> = { updatedAt: patch.updatedAt };
      if (patch.name !== undefined) sets.name = patch.name;
      if (patch.command !== undefined) sets.command = patch.command;
      if (patch.args !== undefined) sets.args = patch.args;
      if (patch.env !== undefined) sets.env = patch.env;
      if (patch.url !== undefined) sets.url = patch.url;
      if (patch.enabled !== undefined) sets.enabled = patch.enabled;
      if (Object.keys(sets).length <= 1) return this.getById(serverId);
      d.update(schema.mcpServer).set(sets).where(eq(schema.mcpServer.serverId, serverId)).run();
      return this.getById(serverId);
    },

    delete(serverId: string): boolean {
      const result = d
        .delete(schema.mcpServer)
        .where(eq(schema.mcpServer.serverId, serverId))
        .returning()
        .all();
      return result.length > 0;
    },
  };
}
