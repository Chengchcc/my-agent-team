import { Elysia } from "elysia";
import { type ApplyDeps, applyProposal, ProposalNotApplicable } from "./apply.js";
import { isProposalKind } from "./domain.js";
import type { ProposalService } from "./service.js";

/** The two edges a page needs: read the pending proposal for a target, and say what it did with
 *  it. The decision has its own first segment instead of living under `proposals/:id`: two paths
 *  that differ only in a second parameter collapse into one route in a typed client, and the
 *  decision travels in the body anyway. */
export function proposalRoutes(service: ProposalService, apply?: ApplyDeps) {
  return new Elysia()
    .get("/api/proposals/pending", ({ query }) => ({
      proposals: service.pendingAll(
        query.kind !== undefined && isProposalKind(query.kind) ? query.kind : undefined,
      ),
    }))
    .get("/api/proposals/:kind/:targetId", ({ params, set }) => {
      if (!isProposalKind(params.kind)) {
        set.status = 400;
        return { error: "unknown proposal kind" };
      }
      return { proposal: service.pending(params.kind, params.targetId) };
    })
    .post("/api/proposal-decisions/:id", async ({ body, params, set }) => {
      const decision = (body as { decision?: unknown } | undefined)?.decision;
      if (decision !== "adopted" && decision !== "discarded") {
        set.status = 400;
        return { error: "decision must be adopted or discarded" };
      }
      // "adopted" must MEAN applied: resolve first, then apply, and roll the
      // decision back if the application fails (measured 2026-11-23: the
      // endpoint answered ok while the config was untouched).
      const pending = service.pendingById(params.id);
      if (pending === null) {
        // A page that adopts after another one already did: the row is not pending any more.
        set.status = 409;
        return { error: "this proposal is no longer pending" };
      }
      if (decision === "adopted" && apply !== undefined) {
        try {
          await applyProposal({
            kind: pending.kind,
            targetId: pending.targetId,
            payload: pending.payload,
            deps: apply,
          });
        } catch (err) {
          set.status = err instanceof ProposalNotApplicable ? 400 : 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (!service.resolve(params.id, decision)) {
        set.status = 409;
        return { error: "this proposal is no longer pending" };
      }
      return { ok: true };
    });
}
