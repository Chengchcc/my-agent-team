import type { ProposalRow } from "./domain.js";

/** Storage for proposed-but-unapplied changes. Deliberately tiny: insert one, read the newest
 *  pending one for a target, and move one out of pending exactly once. */
export interface ProposalPort {
  insert(row: {
    id: string;
    kind: string;
    targetId: string;
    payload: string;
    createdAt: number;
  }): void;
  latestPending(kind: string, targetId: string): ProposalRow | null;
  /** True when this call is what moved the row out of pending — a second attempt is false, and
   *  the route answers 409 rather than pretending the decision landed twice. */
  resolve(id: string, status: string, resolvedAt: number): boolean;
}
