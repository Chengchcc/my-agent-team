import { deserializeLedgerContent, extractText } from "@my-agent-team/message";
import type { LedgerEntry } from "./ledger.js";
import type { Conversation } from "./member.js";

// ─── projectForMember ───────────────────────────────────────

function displayNameOf(conv: Conversation, memberId: string): string {
  const m = conv.members.find((m) => m.memberId === memberId);
  return m?.displayName ?? memberId;
}

/** Extract displayable text from ledger content using unified parser.
 *  LedgerEntry.content is always a serialized string. For message entries it's
 *  a serialized MessageRevision; for other kinds it's JSON.stringify'd payload.
 *  Uses unified deserializeLedgerContent + extractText from @my-agent-team/message. */
function formatContent(content: unknown): string {
  if (typeof content !== "string") {
    if (content && typeof content === "object" && "text" in content) {
      return String((content as { text: unknown }).text);
    }
    return JSON.stringify(content);
  }
  const result = deserializeLedgerContent(content);
  if ("messageId" in result) {
    return extractText(result);
  }
  // Legacy fallback: pre-M17 content stored as {text} shape
  if (result.raw && typeof result.raw === "object" && "text" in result.raw) {
    return String((result.raw as { text: unknown }).text);
  }
  return typeof result.raw === "string" ? result.raw : JSON.stringify(result.raw);
}

export function projectForMember(
  entry: LedgerEntry,
  viewerMemberId: string,
  conv: Conversation,
): { role: "user" | "assistant"; text: string } {
  // Own messages → assistant role, no prefix
  if (entry.senderMemberId === viewerMemberId) {
    return { role: "assistant", text: formatContent(entry.content) };
  }

  // System messages → user role with [系统] prefix
  if (entry.senderMemberId === "__system__") {
    const text = formatContent(entry.content);
    // For member events, produce a human-readable description
    if (entry.kind === "member.joined" || entry.kind === "member.left") {
      const verb = entry.kind === "member.joined" ? "加入" : "离开";
      let payload:
        | { memberId?: string; members?: Array<{ displayName?: string; memberId: string }> }
        | undefined;
      try {
        payload =
          typeof entry.content === "string"
            ? (JSON.parse(entry.content) as typeof payload)
            : (entry.content as typeof payload);
      } catch {
        payload = undefined;
      }
      const who = payload?.memberId ? displayNameOf(conv, payload.memberId) : "未知成员";
      const present =
        payload?.members?.map((m) => displayNameOf(conv, m.memberId)).join(", ") ?? "";
      return {
        role: "user",
        text: `[系统] 成员变化：${who} ${verb}。当前在场：${present}`,
      };
    }
    return { role: "user", text: `[系统] ${text}` };
  }

  // Others' messages → user role with [name]: prefix
  const name = displayNameOf(conv, entry.senderMemberId);
  return { role: "user", text: `[${name}]: ${formatContent(entry.content)}` };
}
