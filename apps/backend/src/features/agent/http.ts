import { Elysia, t } from "elysia";
import type { LarkSetupManager } from "../lark-bot/setup-manager.js";
import type { AgentRow } from "./domain.js";
import type { AgentIdentityStore } from "./identity-store.js";
import type { AgentService } from "./service.js";
import { AgentBusyError, AgentNotFoundError } from "./service.js";

// ── Response types (inferred by Elysia from handler return values) ──

function toAgentResponse(row: AgentRow, status: string) {
  return {
    id: row.id,
    name: row.name,
    template: row.template,
    workspacePath: row.workspacePath,
    modelProvider: row.modelProvider,
    modelName: row.modelName,
    modelBaseUrl: row.modelBaseUrl,
    permissionMode: row.permissionMode,
    maxSteps: row.maxSteps,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    lark: {
      enabled: row.larkEnabled,
      appId: row.larkAppId,
      profileRef: row.larkProfileRef,
      botDisplayName: row.larkBotDisplayName,
      status,
    },
  };
}

function deriveLarkStatus(row: AgentRow, registryStatus?: string): string {
  if (!row.larkEnabled || !row.larkProfileRef) return "not_configured";
  if (registryStatus === "running") return "running";
  if (registryStatus === "degraded") return "degraded";
  if (registryStatus === "error") return "error";
  return "configured";
}

// ── Elysia plugin ──

export function agentRoutes(
  svc: AgentService,
  identityStore?: AgentIdentityStore,
  larkStatusOf?: (agentId: string) => string,
  getSetupManager?: () => LarkSetupManager,
  skillPackSvc?: {
    listForAgent: (agentId: string) => Promise<{ id: string; name: string; status: string }[]>;
    setAgentPacks: (agentId: string, packIds: string[]) => Promise<void>;
  },
) {
  const statusOf = (row: AgentRow) => deriveLarkStatus(row, larkStatusOf?.(row.id));

  const base = new Elysia()
    .get("/api/agents", async () => {
      const rows = await svc.list();
      return rows.map((row) => toAgentResponse(row, statusOf(row)));
    })
    .post(
      "/api/agents",
      async ({ body, set }) => {
        const row = await svc.create(body);
        set.status = 201;
        return toAgentResponse(row, statusOf(row));
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          template: t.Optional(t.String()),
          model: t.Object({
            provider: t.String({ minLength: 1 }),
            model: t.String({ minLength: 1 }),
            baseURL: t.Optional(t.String()),
          }),
          permissionMode: t.Optional(
            t.Union([t.Literal("ask"), t.Literal("auto"), t.Literal("deny")]),
          ),
          maxSteps: t.Optional(t.Integer({ minimum: 1 })),
          lark: t.Optional(
            t.Object({
              enabled: t.Boolean(),
              appId: t.Optional(t.String({ minLength: 1 })),
              appSecret: t.Optional(t.String({ minLength: 1 })),
              botDisplayName: t.Optional(t.String()),
            }),
          ),
        }),
      },
    )
    .get("/api/agents/:id", async ({ params: { id } }) => {
      try {
        const row = await svc.getById(id);
        return toAgentResponse(row, statusOf(row));
      } catch (err) {
        if (err instanceof AgentNotFoundError)
          return Response.json({ error: err.message }, { status: 404 });
        throw err;
      }
    })
    .patch(
      "/api/agents/:id",
      async ({ params: { id }, body }) => {
        try {
          if (body.lark?.enabled === true) {
            const existing = await svc.getById(id);
            const hasExistingProfile = !!existing.larkProfileRef;
            const hasFreshCredentials = !!(body.lark?.appId && body.lark?.appSecret);
            if (!hasExistingProfile && !hasFreshCredentials) {
              return Response.json(
                {
                  error:
                    "lark.enabled=true requires appId+appSecret when no existing profile exists",
                },
                { status: 400 },
              );
            }
          }
          const row = await svc.update(id, body);
          return toAgentResponse(row, statusOf(row));
        } catch (err) {
          if (err instanceof AgentNotFoundError)
            return Response.json({ error: err.message }, { status: 404 });
          throw err;
        }
      },
      {
        body: t.Object({
          name: t.Optional(t.String({ minLength: 1 })),
          permissionMode: t.Optional(
            t.Union([t.Literal("ask"), t.Literal("auto"), t.Literal("deny")]),
          ),
          maxSteps: t.Optional(t.Integer({ minimum: 1 })),
          lark: t.Optional(
            t.Object({
              enabled: t.Optional(t.Boolean()),
              appId: t.Optional(t.String({ minLength: 1 })),
              appSecret: t.Optional(t.String({ minLength: 1 })),
              botDisplayName: t.Optional(t.String()),
            }),
          ),
        }),
      },
    )
    .delete("/api/agents/:id", async ({ params: { id }, query }) => {
      try {
        if (query.hard === "true") {
          await svc.hardDelete(id);
          return { deleted: true, id };
        }
        return svc.archive(id);
      } catch (err) {
        if (err instanceof AgentNotFoundError)
          return Response.json({ error: err.message }, { status: 404 });
        if (err instanceof AgentBusyError)
          return Response.json({ error: err.message }, { status: 409 });
        throw err;
      }
    })
    // Identity
    .get("/api/agents/:id/identity", async ({ params: { id } }) => {
      if (!identityStore) return { soul: null, user: null, memories: [] };
      try {
        return identityStore.getIdentity(id);
      } catch (err) {
        if (err instanceof AgentNotFoundError)
          return Response.json({ error: err.message }, { status: 404 });
        throw err;
      }
    })
    .put(
      "/api/agents/:id/identity",
      async ({ params: { id }, body }) => {
        if (!identityStore)
          return Response.json({ error: "Identity store not available" }, { status: 501 });
        try {
          await identityStore.updateIdentity(id, {
            soul: typeof body.soul === "string" ? body.soul : undefined,
            user: typeof body.user === "string" ? body.user : undefined,
          });
          return { ok: true };
        } catch (err) {
          if (err instanceof AgentNotFoundError)
            return Response.json({ error: err.message }, { status: 404 });
          throw err;
        }
      },
      {
        body: t.Object({
          soul: t.Optional(t.String()),
          user: t.Optional(t.String()),
        }),
      },
    )
    // Lark setup
    .post(
      "/api/agents/:id/lark/setup",
      async ({ params: { id }, body }) => {
        const m = getSetupManager?.();
        if (!m) return Response.json({ error: "Lark setup not available" }, { status: 501 });
        try {
          const existing = await svc.getById(id);
          const pending = m.getByAgentId(id);
          if (pending && pending.status === "pending") return pending;
          const session = await m.create({
            agentId: id,
            botDisplayName:
              typeof body.botDisplayName === "string"
                ? body.botDisplayName
                : (existing.larkBotDisplayName ?? undefined),
            brand: body.brand === "lark" ? "lark" : "feishu",
          });
          return session;
        } catch (err) {
          if (err instanceof AgentNotFoundError)
            return Response.json({ error: err.message }, { status: 404 });
          throw err;
        }
      },
      {
        body: t.Object({
          botDisplayName: t.Optional(t.String()),
          brand: t.Optional(t.Union([t.Literal("feishu"), t.Literal("lark")])),
        }),
      },
    )
    .get("/api/agents/:id/lark/setup/:setupId", ({ params: { id, setupId } }) => {
      const m = getSetupManager?.();
      if (!m) return Response.json({ error: "Lark setup not available" }, { status: 501 });
      const session = m.get(setupId);
      if (!session || session.agentId !== id)
        return Response.json({ error: "Not found" }, { status: 404 });
      return session;
    })
    .delete("/api/agents/:id/lark/setup/:setupId", ({ params: { id, setupId } }) => {
      const m = getSetupManager?.();
      if (!m) return Response.json({ error: "Lark setup not available" }, { status: 501 });
      const session = m.get(setupId);
      if (!session || session.agentId !== id)
        return Response.json({ error: "Not found" }, { status: 404 });
      m.cancel(setupId);
      return { cancelled: true };
    });

  // Skill pack assignment routes (optional)
  if (skillPackSvc) {
    return base
      .get("/api/agents/:id/skill-packs", async ({ params: { id } }) => {
        const packs = await skillPackSvc.listForAgent(id);
        return packs;
      })
      .put(
        "/api/agents/:id/skill-packs",
        async ({ params: { id }, body }) => {
          await skillPackSvc.setAgentPacks(id, body.packIds);
          return { ok: true };
        },
        {
          body: t.Object({
            packIds: t.Array(t.String()),
          }),
        },
      );
  }

  return base;
}
