import type { AgentContextEntry, ContextBranch } from "./domain.js";
import type { AgentContextPort, IdGenerator, LedgerMessageResolver } from "./ports.js";

export interface AgentContextServiceDeps {
  readonly port: AgentContextPort;
  readonly idGen: IdGenerator;
  readonly ledgerResolver: LedgerMessageResolver;
}

/** Product-facing Agent Context service. Lazily creates tree/branch for
 *  existing agent members, manages branch operations, and resolves the
 *  effective model for the next Agent Run. */
export interface AgentContextService {
  getOrCreateDefaultBranch(
    conversationId: string,
    backendKind: string,
    agentId?: string,
  ): Promise<ContextBranch>;

  appendSummary(
    branchId: string,
    expectedRevision: number,
    summary: string,
    coversThroughEntryId: string,
  ): Promise<{ branch: ContextBranch; entryId: string }>;

  forkBranch(
    branchId: string,
    expectedRevision: number,
    fromEntryId: string,
    backendKind?: string,
  ): Promise<{ branch: ContextBranch }>;

  /** Repin the tree's default branch (D2 kind switch). */
  setDefaultBranchKind(
    treeId: string,
    branchId: string,
    backendKind: string,
  ): Promise<ContextBranch>;

  /** Record the branch's CLI session reference (ADR 0019). */
  updateBranchCliSessionRef(branchId: string, cliSessionRef: string): Promise<ContextBranch | null>;

  listEntriesToLeaf(branchId: string): Promise<AgentContextEntry[]>;
}

export function createAgentContextService(deps: AgentContextServiceDeps): AgentContextService {
  const { port } = deps;

  return {
    async getOrCreateDefaultBranch(conversationId, backendKind, agentId) {
      const tree = await port.getOrCreateTree(conversationId, agentId);
      return port.getOrCreateDefaultBranch(tree.treeId, backendKind);
    },

    async appendSummary(branchId, expectedRevision, summary, coversThroughEntryId) {
      const branch = await port.getBranch(branchId);
      if (!branch) throw new Error(`Branch not found: ${branchId}`);
      // Validate the coverage target is on the branch path
      const entries = await port.listEntriesToLeaf(branchId);
      const targetIdx = entries.findIndex((e) => e.entryId === coversThroughEntryId);
      if (targetIdx === -1) {
        throw new Error(
          `Summary coversThroughEntryId ${coversThroughEntryId} is not on branch ${branchId}`,
        );
      }
      return port.appendEntry({
        branchId,
        expectedRevision,
        type: "summary",
        parentId: branch.leafEntryId,
        payload: { summary, coversThroughEntryId },
      });
    },

    async forkBranch(branchId, expectedRevision, fromEntryId, backendKind) {
      return port.forkBranch({
        sourceBranchId: branchId,
        expectedRevision,
        fromEntryId,
        backendKind,
      });
    },

    async setDefaultBranchKind(treeId, branchId, backendKind) {
      return port.setDefaultBranchKind(treeId, branchId, backendKind);
    },

    async updateBranchCliSessionRef(branchId, cliSessionRef) {
      return port.updateBranchCliSessionRef(branchId, cliSessionRef);
    },

    async listEntriesToLeaf(branchId) {
      return port.listEntriesToLeaf(branchId);
    },
  };
}
