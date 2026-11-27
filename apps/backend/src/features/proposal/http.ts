import { Elysia, t } from "elysia";
import { DomainError } from "../../infra/domain-errors.js";
import { parseBoundedLimit } from "../../infra/http-utils.js";
import { type ApplyDeps, applyProposal, ProposalNotApplicable, reviewedPayload } from "./apply.js";
import { isProposalKind } from "./domain.js";
import type { ProposalService } from "./service.js";

/** The two edges a page needs: read the pending proposal for a target, and say what it did with
 *  it. The decision has its own first segment instead of living under `proposals/:id`: two paths
 *  that differ only in a second parameter collapse into one route in a typed client, and the
 *  decision travels in the body anyway. */
export function proposalRoutes(service: ProposalService, apply?: ApplyDeps) {
  // Single-flight guard per proposal id so two concurrent adopt clicks cannot
  // both execute side effects (e.g. creating a project twice) before resolve().
  const inFlight = new Set<string>();
  return new Elysia()
    .get(
      "/api/proposals/pending",
      ({ query }) => {
        const all = service.pendingAll(
          query.kind !== undefined && isProposalKind(query.kind) ? query.kind : undefined,
        );
        const limit = parseBoundedLimit(query.limit, 200, 500);
        return { proposals: all.slice(0, limit) };
      },
      {
        query: t.Object({
          kind: t.Optional(t.String()),
          limit: t.Optional(t.String()),
        }),
      },
    )
    .get("/api/proposals/:kind/:targetId", ({ params, set }) => {
      if (!isProposalKind(params.kind)) {
        set.status = 400;
        return { error: "unknown proposal kind" };
      }
      return { proposal: service.pending(params.kind, params.targetId) };
    })
    .post(
      "/api/proposal-decisions/:id",
      async ({ body, params, set }) => {
        const decision = body.decision;
        if (decision !== "adopted" && decision !== "discarded") {
          set.status = 400;
          return { error: "decision must be adopted or discarded" };
        }
        if (inFlight.has(params.id)) {
          set.status = 409;
          return { error: "this proposal is already being processed" };
        }
        inFlight.add(params.id);
        try {
          // "adopted" must MEAN applied: apply first, and leave the row pending when the
          // application fails (measured 2026-11-23: the endpoint answered ok while the
          // config was untouched).
          const pending = service.pendingById(params.id);
          if (pending === null) {
            // A page that adopts after another one already did: the row is not pending any more.
            set.status = 409;
            return { error: "this proposal is no longer pending" };
          }
          // A page that let the human review the suggestion in a form sends what they saved:
          // that is what gets applied, and what the row records from then on.
          const applied = reviewedPayload(pending.kind, pending.payload, body.payload);
          if (decision === "adopted" && apply !== undefined) {
            try {
              await applyProposal({
                kind: pending.kind,
                targetId: pending.targetId,
                payload: applied,
                deps: apply,
              });
            } catch (err) {
              if (err instanceof ProposalNotApplicable) {
                set.status = 400;
                return { error: err.message };
              }
              if (err instanceof DomainError) {
                set.status = err.status;
                return { error: err.message };
              }
              console.error(`[proposal] apply failed for ${params.id}:`, err);
              set.status = 500;
              return { error: "Failed to apply proposal" };
            }
          }
          const recorded = decision === "adopted" ? applied : undefined;
          if (!service.resolve(params.id, decision, recorded)) {
            set.status = 409;
            return { error: "this proposal is no longer pending" };
          }
          return { ok: true };
        } finally {
          inFlight.delete(params.id);
        }
      },
      {
        body: t.Object({
          decision: t.Optional(t.String()),
          payload: t.Optional(t.Unknown()),
        }),
      },
    );
}
