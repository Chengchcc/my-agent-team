import { Elysia, t } from "elysia";
import type { EntityLabelResolver } from "../../infra/entity-labels.js";
import { RequirementNotFoundError, type RequirementService } from "./service.js";

/** ADR 0074 S1 + ADR 0082: the requirement read/write surface. List and detail are the
 *  "requirements by goal" view, supporting project/conversation deep-link filters and
 *  attaching human-readable labels at the read boundary. */
export function requirementRoutes(
  svc: RequirementService,
  linkage?: {
    requirementIdsForConversation?: (conversationId: string) => string[];
    labelResolver?: EntityLabelResolver;
  },
) {
  return new Elysia()
    .get("/api/requirements", ({ query }) => {
      let rows = svc.list(query.closed === "1");
      if (query.projectId) {
        rows = rows.filter((r) => r.projectId === query.projectId);
      }
      if (query.conversationId) {
        const linkedIds = new Set(
          linkage?.requirementIdsForConversation?.(query.conversationId) ?? [],
        );
        rows = rows.filter(
          (r) => r.originConversationId === query.conversationId || linkedIds.has(r.requirementId),
        );
      }
      if (!linkage?.labelResolver || rows.length === 0) {
        return { requirements: rows };
      }
      const maps = linkage.labelResolver.resolveBatch({
        agentIds: rows.map((r) => r.createdByAgentId),
        projectIds: rows.map((r) => r.projectId),
        conversationIds: rows.map((r) => r.originConversationId),
      });
      return {
        requirements: rows.map((r) => {
          const labels = linkage.labelResolver!.labelsFor(
            {
              agentId: r.createdByAgentId,
              projectId: r.projectId,
              conversationId: r.originConversationId,
            },
            maps,
          );
          return labels ? { ...r, labels } : r;
        }),
      };
    })
    .get("/api/requirements/:id", ({ params: { id }, set }) => {
      try {
        const view = svc.get(id);
        const labels = linkage?.labelResolver?.labelsFor({
          agentId: view.requirement.createdByAgentId,
          projectId: view.requirement.projectId,
          conversationId: view.requirement.originConversationId,
        });
        return labels ? { ...view, labels } : view;
      } catch (err) {
        if (err instanceof RequirementNotFoundError) {
          set.status = 404;
          return { error: err.message };
        }
        throw err;
      }
    })
    .patch(
      "/api/requirements/:id",
      ({ params: { id }, body, set }) => {
        try {
          // ADR 0080: a person's acceptance records WHAT they accepted — the
          // runs and their verification verdicts at that moment. Without it the
          // north star ("accepted work") has no evidence to point at, and a
          // later run would silently rewrite the basis.
          const acceptance =
            body.status === "done"
              ? {
                  acceptedAt: Date.now(),
                  acceptedEvidence: (() => {
                    try {
                      const view = svc.get(id);
                      const refs = view.runs.map(
                        (r) => `run:${r.runId} ${r.verification ?? "unverified"}`,
                      );
                      return refs.length > 0 ? refs : ["no runs at acceptance"];
                    } catch {
                      return ["no runs at acceptance"];
                    }
                  })(),
                }
              : {};
          return { requirement: svc.update(id, { ...body, ...acceptance }) };
        } catch (err) {
          if (err instanceof RequirementNotFoundError) {
            set.status = 404;
            return { error: err.message };
          }
          throw err;
        }
      },
      {
        body: t.Object({
          title: t.Optional(t.String({ minLength: 1 })),
          goal: t.Optional(t.String({ minLength: 1 })),
          background: t.Optional(t.Nullable(t.String())),
          constraints: t.Optional(t.Nullable(t.String())),
          expectedDeliverables: t.Optional(t.Nullable(t.String())),
          acceptanceCriteria: t.Optional(t.Nullable(t.String())),
          status: t.Optional(
            t.Union([t.Literal("open"), t.Literal("done"), t.Literal("cancelled")]),
          ),
        }),
      },
    );
}
