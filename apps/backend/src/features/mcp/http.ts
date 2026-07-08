import { Elysia, t } from "elysia";
import { McpServerNotFoundError, type McpService, McpValidationError } from "./service.js";

export function mcpRoutes(svc: McpService) {
  return new Elysia()
    .get("/api/agents/:id/mcp-servers", ({ params: { id } }) => {
      return { mcpServers: svc.listByAgent(id) };
    })
    .post(
      "/api/agents/:id/mcp-servers",
      async ({ params: { id }, body, set }) => {
        try {
          const server = await svc.create(id, body);
          set.status = 201;
          return { mcpServer: server };
        } catch (e) {
          if (e instanceof McpValidationError)
            return Response.json({ error: e.message }, { status: 422 });
          throw e;
        }
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          transport: t.Union([t.Literal("stdio"), t.Literal("sse")]),
          command: t.Optional(t.String()),
          args: t.Optional(t.Array(t.String())),
          env: t.Optional(t.Record(t.String(), t.String())),
          url: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
        }),
      },
    )
    .put(
      "/api/agents/:id/mcp-servers/:serverId",
      async ({ params: { id, serverId }, body }) => {
        try {
          const server = await svc.update(id, serverId, body);
          return { mcpServer: server };
        } catch (e) {
          if (e instanceof McpServerNotFoundError)
            return Response.json({ error: e.message }, { status: 404 });
          if (e instanceof McpValidationError)
            return Response.json({ error: e.message }, { status: 422 });
          throw e;
        }
      },
      {
        body: t.Object({
          name: t.Optional(t.String()),
          command: t.Optional(t.String()),
          args: t.Optional(t.Array(t.String())),
          env: t.Optional(t.Record(t.String(), t.String())),
          url: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
        }),
      },
    )
    .delete("/api/agents/:id/mcp-servers/:serverId", async ({ params: { id, serverId }, set }) => {
      try {
        await svc.delete(id, serverId);
        set.status = 204;
        return new Response(null, { status: 204 });
      } catch (e) {
        if (e instanceof McpServerNotFoundError)
          return Response.json({ error: e.message }, { status: 404 });
        throw e;
      }
    });
}
