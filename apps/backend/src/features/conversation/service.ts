import { Conversation as ConversationSchema, projectForMember } from "@my-agent-team/conversation";
import type { CheckpointReadPort, CheckpointWritePort } from "../checkpoint/ports.js";
import type { ConversationPort, LedgerRow } from "./ports.js";

export interface ConversationServiceDeps {
  port: ConversationPort;
  checkpointRead: CheckpointReadPort;
  checkpointWrite: CheckpointWritePort;
}

function deriveThreadId(conversationId: string, memberId: string): string {
  return `${conversationId}:${memberId}`;
}

export function createConversationService(deps: ConversationServiceDeps) {
  const { port, checkpointRead, checkpointWrite } = deps;

  return {
    /** Project a ledger entry into all agent member checkpoints. */
    async broadcastMessage(entry: LedgerRow): Promise<void> {
      // Build Conversation from DB for projectForMember
      const convRow = port.getConversation(entry.conversationId);
      if (!convRow) return;

      const memberRows = port.getAgentMembers(entry.conversationId);
      const allMembers = port.getMembers(entry.conversationId).map((m) => ({
        kind: m.kind as "agent" | "human",
        memberId: m.memberId,
        agentId: m.agentId ?? undefined,
        userRef: m.userRef ?? undefined,
        displayName: m.displayName ?? undefined,
      }));

      const conv = ConversationSchema.parse({
        conversationId: entry.conversationId,
        members: allMembers,
        triggerMode: convRow.triggerMode,
        createdAt: convRow.createdAt,
      });

      // Parse content for projection
      let content: unknown;
      try {
        content = JSON.parse(entry.content);
      } catch {
        content = entry.content;
      }

      // Project into each agent member's thread
      for (const member of memberRows) {
        const threadId = deriveThreadId(entry.conversationId, member.memberId);
        const projected = projectForMember(
          {
            seq: entry.seq,
            conversationId: entry.conversationId,
            senderMemberId: entry.senderMemberId,
            addressedTo: entry.addressedTo,
            kind: entry.kind,
            content,
            ts: entry.ts,
          },
          member.memberId,
          conv,
        );

        await checkpointWrite.appendMessages(threadId, [
          { role: projected.role, content: projected.text },
        ]);
      }
    },
  };
}
