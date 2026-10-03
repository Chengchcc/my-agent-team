/** ADR 0041 conversation member rules. The roster is the routing truth;
 *  conversation.agentId remains only as the default member for legacy
 *  compatibility. Adding a member flips the room to mention-only routing
 *  automatically (semantics are derived, never stored). */

export class MemberRuleError extends Error {}

export interface ConversationMemberOps {
  /** The conversation's agent members. */
  list(conversationId: string): string[];
  /** Add a member (idempotent). The added agent's context tree is created
   *  lazily on its first triggered run — membership alone owns nothing. */
  add(conversationId: string, agentId: string): boolean | Promise<boolean>;
  /** Remove a member. The last member cannot be removed (a conversation
   *  with zero members is a dead room); removing never touches the agent's
   *  context tree — history stays, only routing drops. */
  remove(conversationId: string, agentId: string): boolean;
}

export function createConversationMembers(deps: {
  /** Same optional-member shape as ConversationPort — a port double without
   *  the ADR 0041 methods degrades to no-ops instead of failing to type. */
  port: {
    listMembers?(conversationId: string): string[];
    addMember?(conversationId: string, agentId: string, addedAt: number): boolean;
    removeMember?(conversationId: string, agentId: string): boolean;
  };
  agentExists(agentId: string): boolean | Promise<boolean>;
  now?: () => number;
}): ConversationMemberOps {
  const now = deps.now ?? (() => Date.now());
  return {
    list: (cid) => deps.port.listMembers?.(cid) ?? [],
    async add(cid, agentId) {
      const exists = await deps.agentExists(agentId);
      if (!exists) throw new MemberRuleError(`unknown agent ${agentId}`);
      return deps.port.addMember?.(cid, agentId, now()) ?? false;
    },
    remove(cid, agentId) {
      const members = deps.port.listMembers?.(cid) ?? [];
      if (members.length <= 1 && members.includes(agentId)) {
        throw new MemberRuleError("cannot remove the last member of a conversation");
      }
      return deps.port.removeMember?.(cid, agentId) ?? false;
    },
  };
}
