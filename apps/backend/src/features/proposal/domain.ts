/** A change an agent proposed but did not make (ADR 0040). An MCP tool cannot apply a config or a
 *  definition rewrite: it proposes one, and the target page adopts it as an unsaved edit the human
 *  commits. The row is what makes the tool's own answer true — the page can be opened later and the
 *  proposal is still there to review. */
export type ProposalKind = "agent_config" | "workflow_definition";
export type ProposalStatus = "pending" | "adopted" | "discarded";

export interface PendingProposal {
  id: string;
  kind: ProposalKind;
  targetId: string;
  /** What was proposed, as the tool sent it. Unknown out here on purpose: a page renders what it
   *  recognises, exactly as it does for a saved config or definition. */
  payload: unknown;
  createdAt: number;
}

/** The stored shape: the payload is JSON text until the service parses it. */
export interface ProposalRow {
  id: string;
  kind: string;
  targetId: string;
  payload: string;
  status: string;
  createdAt: number;
  resolvedAt: number | null;
}

const KINDS = ["agent_config", "workflow_definition"] as const satisfies readonly ProposalKind[];

/** A kind that came off the wire. Only the tools write proposals, so an unknown one is a bug or a
 *  hand-edited row: it is refused rather than guessed at. */
export function isProposalKind(value: unknown): value is ProposalKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}
