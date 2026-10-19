// ─── Errors ──────────────────────────────────────────────────────

export class AgentContextNotFoundError extends Error {
  constructor(readonly conversationId: string) {
    super(`Agent Context not found for ${conversationId}`);
    this.name = "AgentContextNotFoundError";
  }
}

export class ContextBranchNotFoundError extends Error {
  constructor(readonly branchId: string) {
    super(`Context Branch not found: ${branchId}`);
    this.name = "ContextBranchNotFoundError";
  }
}

export class ContextRevisionConflictError extends Error {
  constructor(
    readonly branchId: string,
    readonly expectedRevision: number,
  ) {
    super(`Context revision conflict on branch ${branchId}: expected ${expectedRevision}`);
    this.name = "ContextRevisionConflictError";
  }
}

// ─── Tree ────────────────────────────────────────────────────────

export interface AgentContextTree {
  readonly treeId: string;
  readonly conversationId: string;
  /** ADR 0041: the member agent owning this context line. Null on legacy
   *  rows and on conversations without members (single-agent default). */
  readonly agentId: string | null;
  readonly createdAt: number;
}

// ─── Entry types ─────────────────────────────────────────────────

export type AgentContextEntryType = "ledger_message" | "summary";

export interface LedgerMessageEntry {
  readonly type: "ledger_message";
  readonly entryId: string;
  readonly parentId: string | null;
  readonly ledgerSeq: number;
  readonly createdAt: number;
}

export interface ProductSummaryEntry {
  readonly type: "summary";
  readonly entryId: string;
  readonly parentId: string | null;
  readonly summary: string;
  readonly coversThroughEntryId: string;
  readonly createdAt: number;
}

export type AgentContextEntry = LedgerMessageEntry | ProductSummaryEntry;

// ─── Branch ──────────────────────────────────────────────────────

export interface ContextBranch {
  readonly branchId: string;
  readonly treeId: string;
  readonly leafEntryId: string | null;
  readonly ledgerCursor: number;
  readonly backendKind: string;
  /** CLI session reference (ADR 0019): claude session_id or pi/omp
   *  session file path — the CLI-side runtime truth for context
   *  continuation. Null until the first CLI-backed run. */
  readonly cliSessionRef: string | null;
  readonly isDefault: boolean;
  readonly revision: number;
  readonly createdAt: number;
}
