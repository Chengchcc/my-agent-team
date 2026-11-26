import { Elysia, t } from "elysia";
import { HttpError } from "../../infra/errors.js";
import type { ArtifactService } from "./service.js";

export function artifactRoutes(service: ArtifactService) {
  return new Elysia({ prefix: "/api/artifacts" })
    .get(
      "/",
      async ({ query }) => {
        const filter = {
          ...(query.folder ? { folder: String(query.folder) } : {}),
          ...(query.requirementId ? { requirementId: String(query.requirementId) } : {}),
          ...(query.conversationId ? { conversationId: String(query.conversationId) } : {}),
          ...(query.workflowExecutionId
            ? { workflowExecutionId: String(query.workflowExecutionId) }
            : {}),
          ...(query.agentId ? { agentId: String(query.agentId) } : {}),
          ...(query.projectId ? { projectId: String(query.projectId) } : {}),
          ...(query.runId ? { runId: String(query.runId) } : {}),
        };
        return {
          artifacts: await service.list(Object.keys(filter).length > 0 ? filter : undefined),
        };
      },
      {
        query: t.Object({
          folder: t.Optional(t.String()),
          requirementId: t.Optional(t.String()),
          conversationId: t.Optional(t.String()),
          workflowExecutionId: t.Optional(t.String()),
          agentId: t.Optional(t.String()),
          projectId: t.Optional(t.String()),
          runId: t.Optional(t.String()),
        }),
      },
    )
    .get(
      // Must precede "/:url" — that route would swallow "meta" as an id.
      "/meta",
      async ({ query }) => {
        const meta = await service.getMeta(query.url);
        if (!meta) throw new HttpError(`artifact not found: ${query.url}`, 404);
        return { artifact: meta };
      },
      {
        query: t.Object({ url: t.String({ minLength: 1 }) }),
      },
    )
    .get(
      "/download",
      async ({ query }) => {
        return service.download(query.url);
      },
      {
        query: t.Object({ url: t.String({ minLength: 1 }) }),
      },
    )
    .get(
      // Must precede "/:url" — that route would swallow "verify" as an id.
      "/verify",
      async ({ query }) => {
        const result = await service.verify(query.url);
        if (!result) throw new HttpError(`artifact not found: ${query.url}`, 404);
        return result;
      },
      {
        query: t.Object({ url: t.String({ minLength: 1 }) }),
      },
    )
    .get(
      "/:url",
      async ({ params }) => {
        const url = decodeURIComponent(params.url);
        return service.download(url);
      },
      {
        params: t.Object({ url: t.String() }),
      },
    )
    .post(
      "/",
      async ({ body, set }) => {
        const meta = await service.upload({
          folder: body.folder,
          filename: body.filename,
          content: body.content,
          encoding: body.encoding,
          source: body.source,
        });
        set.status = 201;
        return meta;
      },
      {
        body: t.Object({
          folder: t.String(),
          filename: t.String(),
          content: t.String(),
          encoding: t.Optional(t.Union([t.Literal("utf8"), t.Literal("base64")])),
          source: t.Optional(
            t.Object({
              runId: t.Optional(t.String()),
              conversationId: t.Optional(t.String()),
              requirementId: t.Optional(t.String()),
              workflowExecutionId: t.Optional(t.String()),
              agentId: t.Optional(t.String()),
              projectId: t.Optional(t.String()),
            }),
          ),
        }),
      },
    )
    .delete(
      "/remove",
      async ({ query }) => {
        const ok = await service.delete(query.url);
        return { ok };
      },
      {
        query: t.Object({ url: t.String({ minLength: 1 }) }),
      },
    )
    .delete(
      "/:url",
      async ({ params }) => {
        const url = decodeURIComponent(params.url);
        const ok = await service.delete(url);
        return { ok };
      },
      {
        params: t.Object({ url: t.String() }),
      },
    );
}
