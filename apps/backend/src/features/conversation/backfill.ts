import type { Database } from "bun:sqlite";
import type { ConversationPort } from "./ports.js";

/**
 * One-time backfill: for each legacy thread (no conversation row yet),
 * create a degenerate conversation (conversationId = threadId) with
 * one HumanMember + one AgentMember + a "members joined" ledger entry.
 *
 * Idempotent: skips threads that already have a conversation row.
 */
export function backfillLegacyThreads(
  db: Database,
  port: ConversationPort,
): void {
  // L5: Use cursor-based iteration instead of loading all threads into memory
  const query = db.query(
    "SELECT t.id, t.agent_id, t.title FROM threads t WHERE NOT EXISTS (SELECT 1 FROM conversation c WHERE c.conversation_id = t.id)",
  );

  for (const thread of query.iterate() as Iterable<{ id: string; agent_id: string; title: string | null }>) {
    const now = Date.now();

    // Create degenerate conversation (id = threadId)
    port.createConversation({
      conversationId: thread.id,
      triggerMode: "mention",
      createdAt: now,
    });

    // Add human member (backfill placeholder)
    port.addMember({
      memberId: `human-${thread.id}`,
      conversationId: thread.id,
      kind: "human",
      userRef: "__legacy__",
      displayName: "User",
      joinedAt: now,
    });

    // Add agent member (from the thread's agent_id)
    port.addMember({
      memberId: `agent-${thread.id}`,
      conversationId: thread.id,
      kind: "agent",
      agentId: thread.agent_id,
      displayName: thread.title ?? `Agent ${thread.agent_id}`,
      joinedAt: now,
    });

    // Ledger: members joined
    const members = port.getMembers(thread.id);
    port.appendLedgerEntry({
      conversationId: thread.id,
      senderMemberId: "__system__",
      kind: "member.joined",
      content: JSON.stringify({
        memberIds: members.map((m) => m.memberId),
        members: members.map((m) => ({
          memberId: m.memberId,
          kind: m.kind,
          displayName: m.displayName,
        })),
      }),
      ts: now,
    });
  }
}
