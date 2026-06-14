import { z } from "zod";
import { json, parseJsonBody } from "../../http/response.js";
import type { AgentRow } from "./domain.js";
import type { AgentIdentityStore } from "./identity-store.js";
import type { AgentService } from "./service.js";
import { AgentBusyError, AgentNotFoundError } from "./service.js";

const larkCreateSchema = z
  .object({
    enabled: z.boolean(),
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    botDisplayName: z.string().optional(),
  })
  .optional()
  .refine(
    (data) => {
      if (!data) return true;
      if (data.enabled) return !!data.appId && !!data.appSecret;
      return true;
    },
    { message: "lark.enabled=true requires lark.appId and lark.appSecret" },
  );

const larkUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    appId: z.string().min(1).optional(),
    appSecret: z.string().min(1).optional(),
    botDisplayName: z.string().optional(),
    // profileRef is intentionally NOT accepted from clients —
    // it is a server-generated internal reference to lark-cli profile
  })
  .optional()
  .refine(
    (data) => {
      if (!data) return true;
      if (data.enabled === true) {
        // Must provide fresh credentials to enable Lark.
        // Re-enabling with existing profile (no secret needed) is handled
        // by the service layer checking the existing row.
        return !!(data.appId && data.appSecret);
      }
      return true;
    },
    { message: "lark.enabled=true requires appId and appSecret" },
  );

const createSchema = z.object({
  name: z.string().min(1),
  template: z.string().optional(),
  model: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    baseURL: z.string().url().optional(),
  }),
  permissionMode: z.enum(["ask", "auto", "deny"]).optional(),
  maxSteps: z.number().int().positive().optional(),
  lark: larkCreateSchema,
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  permissionMode: z.enum(["ask", "auto", "deny"]).optional(),
  maxSteps: z.number().int().positive().optional(),
  lark: larkUpdateSchema,
});

function deriveLarkStatus(row: AgentRow, registryStatus?: string): string {
  if (!row.larkEnabled || !row.larkProfileRef) return "not_configured";
  if (registryStatus === "running") return "running";
  if (registryStatus === "degraded") return "degraded";
  if (registryStatus === "error") return "error";
  return "configured";
}

export function agentRoutes(
  svc: AgentService,
  identityStore?: AgentIdentityStore,
  larkStatusOf?: (agentId: string) => string,
) {
  return {
    async create(req: Request): Promise<Response> {
      const body = await parseJsonBody(req);
      if ("error" in body) return body.error;
      const parsed = createSchema.safeParse(body.data);
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      const row = await svc.create(parsed.data);
      return json(
        {
          ...row,
          lark: {
            enabled: row.larkEnabled,
            appId: row.larkAppId,
            profileRef: row.larkProfileRef,
            botDisplayName: row.larkBotDisplayName,
            status: deriveLarkStatus(row, larkStatusOf?.(row.id)),
          },
        },
        201,
      );
    },

    async list(_req: Request): Promise<Response> {
      const rows = await svc.list();
      return json(
        rows.map((row) => ({
          ...row,
          lark: {
            enabled: row.larkEnabled,
            appId: row.larkAppId,
            profileRef: row.larkProfileRef,
            botDisplayName: row.larkBotDisplayName,
            status: deriveLarkStatus(row, larkStatusOf?.(row.id)),
          },
        })),
      );
    },

    async getById(_req: Request, id: string): Promise<Response> {
      try {
        const row = await svc.getById(id);
        return json({
          ...row,
          lark: {
            enabled: row.larkEnabled,
            appId: row.larkAppId,
            profileRef: row.larkProfileRef,
            botDisplayName: row.larkBotDisplayName,
            status: deriveLarkStatus(row, larkStatusOf?.(row.id)),
          },
        });
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },

    async update(req: Request, id: string): Promise<Response> {
      const body = await parseJsonBody(req);
      if ("error" in body) return body.error;
      const parsed = updateSchema.safeParse(body.data);
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      try {
        const row = await svc.update(id, parsed.data);
        return json({
          ...row,
          lark: {
            enabled: row.larkEnabled,
            appId: row.larkAppId,
            profileRef: row.larkProfileRef,
            botDisplayName: row.larkBotDisplayName,
            status: deriveLarkStatus(row, larkStatusOf?.(row.id)),
          },
        });
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },

    async archive(req: Request, id: string): Promise<Response> {
      try {
        const url = new URL(req.url);
        const hard = url.searchParams.get("hard");
        if (hard === "true") {
          await svc.hardDelete(id);
          return json({ deleted: true, id });
        }
        return json(await svc.archive(id));
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        if (err instanceof AgentBusyError) return json({ error: err.message }, 409);
        throw err;
      }
    },

    /** D11: GET /api/agents/:id/identity — read SOUL.md, USER.md,
     *  memory/MEMORY.md and memory/facts/*.md from runner sharedRoot
     *  (single source of truth after M14.7).
     *  Falls back to empty if identityStore is not configured. */
    async identity(_req: Request, agentId: string): Promise<Response> {
      if (!identityStore) return json({ soul: null, user: null, memories: [] });
      try {
        const data = await identityStore.getIdentity(agentId);
        return json(data);
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },

    /** PUT /api/agents/:id/identity — write SOUL.md and/or USER.md to runner sharedRoot. */
    async updateIdentity(req: Request, agentId: string): Promise<Response> {
      if (!identityStore) return json({ error: "Identity store not available" }, 501);
      try {
        const body = (await req.json().catch(() => ({}))) as {
          soul?: string;
          user?: string;
        };
        await identityStore.updateIdentity(agentId, {
          soul: typeof body.soul === "string" ? body.soul : undefined,
          user: typeof body.user === "string" ? body.user : undefined,
        });
        return json({ ok: true });
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },
  };
}
