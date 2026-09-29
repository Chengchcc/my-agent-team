import { Elysia } from "elysia";
import { isProposalKind } from "./domain.js";
import type { ProposalService } from "./service.js";

/** The two edges a page needs: read the pending proposal for a target, and say what it did with
 *  it. Nothing lists proposals — one target has one pending proposal at a time. */
export function proposalRoutes(service: ProposalService) {
  return new Elysia()
    .get("/api/proposals/:kind/:targetId", ({ params, set }) => {
      if (!isProposalKind(params.kind)) {
        set.status = 400;
        return { error: "unknown proposal kind" };
      }
      return { proposal: service.pending(params.kind, params.targetId) };
    })
    .post("/api/proposals/:id/:decision", ({ params, set }) => {
      if (params.decision !== "adopted" && params.decision !== "discarded") {
        set.status = 400;
        return { error: "decision must be adopted or discarded" };
      }
      if (!service.resolve(params.id, params.decision)) {
        // A page that adopts after another one already did: the row is not pending any more.
        set.status = 409;
        return { error: "this proposal is no longer pending" };
      }
      return { ok: true };
    });
}
