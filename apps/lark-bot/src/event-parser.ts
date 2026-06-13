/** Flattened NDJSON event from lark-cli event consume im.message.receive_v1.
 *  Fields match the Process-hook-processed output (mentions already resolved to @name in content). */
export interface LarkMessageEvent {
  type: string;
  event_id: string;
  timestamp: string;
  id: string;
  message_id: string;
  create_time: string;
  chat_id: string;
  chat_type: "p2p" | "group";
  message_type: string;
  sender_id: string;
  content: string;
  /** Populated from fixture calibration; null until confirmed */
  senderDisplayName?: string | null;
}

export function parseEvent(line: string): LarkMessageEvent | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;

    if (typeof raw.event_id !== "string" || !raw.event_id) return null;
    if (typeof raw.message_id !== "string" || !raw.message_id) return null;
    if (typeof raw.chat_id !== "string" || !raw.chat_id) return null;
    if (typeof raw.sender_id !== "string" || !raw.sender_id) return null;
    if (raw.chat_type !== "p2p" && raw.chat_type !== "group") return null;
    if (typeof raw.content !== "string") return null;

    return {
      type: typeof raw.type === "string" ? raw.type : "",
      event_id: raw.event_id,
      timestamp: typeof raw.timestamp === "string" ? raw.timestamp : "",
      id: typeof raw.id === "string" ? raw.id : raw.message_id,
      message_id: raw.message_id,
      create_time: typeof raw.create_time === "string" ? raw.create_time : "",
      chat_id: raw.chat_id,
      chat_type: raw.chat_type,
      message_type: typeof raw.message_type === "string" ? raw.message_type : "text",
      sender_id: raw.sender_id,
      content: raw.content,
      senderDisplayName:
        typeof raw.senderDisplayName === "string" ? raw.senderDisplayName : null,
    };
  } catch {
    return null;
  }
}

/** Check if the message content contains @mention of the bot by display name.
 *  Relies on lark-cli's Process hook having resolved mention keys to @name in content text. */
export function isBotMentioned(content: string, botDisplayName: string): boolean {
  return content.includes("@" + botDisplayName);
}
