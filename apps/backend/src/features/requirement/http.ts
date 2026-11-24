import { Elysia, t } from "elysia";
import { RequirementNotFoundError, type RequirementService } from "./service.js";

/** ADR 0074 S1: the requirement read/write surface. List and detail are the
 *  "requirements by goal" view; PATCH is the human's correction lever (merge,
 *  split and re-title — the PA proposes, the person settles). */
export function requirementRoutes(svc: RequirementService) {
  return new Elysia()
    .get("/api/requirements", ({ query }) => ({
      requirements: svc.list(query.closed === "1"),
    }))
    .get("/api/requirements/:id", ({ params: { id }, set }) => {
      try {
        return svc.get(id);
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
