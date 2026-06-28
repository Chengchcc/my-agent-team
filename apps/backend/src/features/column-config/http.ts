import type { IssueStatus } from "@my-agent-team/api-contract";
import { Elysia, t } from "elysia";
import { validateTemplate } from "../orchestrator/render.js";
import { ColumnConfigNotFoundError, type ColumnConfigService, ValidationError } from "./service.js";

export function columnConfigRoutes(svc: ColumnConfigService) {
  return new Elysia()
    .get("/api/column-configs", ({ query: { projectId } }) => {
      if (!projectId) return Response.json({ error: "projectId required" }, { status: 400 });
      return { configs: svc.listByProject(projectId) };
    })
    .post(
      "/api/column-configs",
      ({ body, set }) => {
        const tmplErr = validateTemplate(body.promptTemplate);
        if (tmplErr)
          return Response.json({ error: `Invalid template: ${tmplErr}` }, { status: 400 });
        try {
          const config = svc.upsert({ ...body, status: body.status as IssueStatus });
          set.status = 201;
          return { config };
        } catch (err) {
          if (err instanceof ValidationError)
            return Response.json({ error: err.message }, { status: 400 });
          throw err;
        }
      },
      {
        body: t.Object({
          projectId: t.String({ minLength: 1 }),
          status: t.String(),
          agentId: t.String({ minLength: 1 }),
          promptTemplate: t.String({ minLength: 1 }),
        }),
      },
    )
    .delete("/api/column-configs/:id", ({ params: { id }, set }) => {
      try {
        svc.remove(id);
        set.status = 204;
        return "";
      } catch (err) {
        if (err instanceof ColumnConfigNotFoundError)
          return Response.json({ error: err.message }, { status: 404 });
        throw err;
      }
    });
}
