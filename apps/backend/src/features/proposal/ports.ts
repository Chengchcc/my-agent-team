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
  /** Direct PK lookup for a single still-pending proposal (never bounded by listPending). */
  getPendingById?(id: string): ProposalRow | null;
  /** Every still-pending proposal, newest first. The inbox that lets a person
   *  adopt a project the assistant proposed but no page was open for. */
  listPending(kind?: string): ProposalRow[];
  /** True when this call is what moved the row out of pending — a second attempt is false, and
   *  the route answers 409 rather than pretending the decision landed twice. `payload` is what was
   *  actually applied when the human reviewed the proposal first; it replaces what the tool sent,
   *  so the row records the decision that was made and not an earlier draft of it. */
  resolve(id: string, status: string, resolvedAt: number, payload?: string): boolean;
}
