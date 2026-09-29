import {
  isProposalKind,
  type PendingProposal,
  type ProposalKind,
  type ProposalRow,
} from "./domain.js";
import type { ProposalPort } from "./ports.js";

export interface ProposalService {
  /** Record what a tool proposed. The newest pending one wins: a page reads the latest, so an
   *  older pending row is left where it is rather than rewritten. */
  propose(kind: ProposalKind, targetId: string, payload: unknown): PendingProposal;
  pending(kind: ProposalKind, targetId: string): PendingProposal | null;
  resolve(id: string, decision: "adopted" | "discarded"): boolean;
}

export function createProposalService(deps: {
  port: ProposalPort;
  idGen: () => string;
  now?: () => number;
}): ProposalService {
  const now = deps.now ?? (() => Date.now());
  return {
    propose(kind, targetId, payload) {
      const createdAt = now();
      const id = deps.idGen();
      deps.port.insert({
        id,
        kind,
        targetId,
        payload: JSON.stringify(payload ?? null),
        createdAt,
      });
      return { id, kind, targetId, payload, createdAt };
    },

    pending(kind, targetId) {
      const row = deps.port.latestPending(kind, targetId);
      return row === null ? null : toProposal(row);
    },

    resolve(id, decision) {
      return deps.port.resolve(id, decision, now());
    },
  };
}

/** A stored row as the service hands it out. A row whose kind nobody recognises is dropped rather
 *  than reported with a guessed kind: only the tools write these, so it means the row is not ours. */
function toProposal(row: ProposalRow): PendingProposal | null {
  if (!isProposalKind(row.kind)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null;
  }
  return { id: row.id, kind: row.kind, targetId: row.targetId, payload, createdAt: row.createdAt };
}
