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
  /** Every pending proposal (optionally one kind), newest first. */
  pendingAll(kind?: ProposalKind): PendingProposal[];
  /** One pending proposal by id (the decision route applies before resolving). */
  pendingById(id: string): PendingProposal | null;
  /** `payload` is the reviewed values an adoption applied; the row then holds them instead of
   *  what the tool sent. */
  resolve(id: string, decision: "adopted" | "discarded", payload?: unknown): boolean;
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

    pendingById(id) {
      const row =
        deps.port.getPendingById !== undefined
          ? deps.port.getPendingById(id)
          : (deps.port.listPending().find((r) => r.id === id) ?? null);
      if (!row) return null;
      return toProposal(row);
    },

    pendingAll(kind) {
      // Rows with an unknown kind or unreadable payload are skipped, not
      // surfaced as nulls: the inbox lists only what a page can act on.
      const out: PendingProposal[] = [];
      for (const row of deps.port.listPending(kind)) {
        const proposal = toProposal(row);
        if (proposal !== null) out.push(proposal);
      }
      return out;
    },

    pending(kind, targetId) {
      const row = deps.port.latestPending(kind, targetId);
      return row === null ? null : toProposal(row);
    },

    resolve(id, decision, payload) {
      const applied = payload === undefined ? undefined : JSON.stringify(payload);
      return deps.port.resolve(id, decision, now(), applied);
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
