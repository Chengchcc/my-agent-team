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
    const raw = JSON.parse(line);
    if (!raw.event_id || !raw.chat_id || !raw.sender_id) return null;
    return raw as LarkMessageEvent;
  } catch {
    return null;
  }
}

/** Check if the message content contains @mention of the bot by display name.
 *  Relies on lark-cli's Process hook having resolved mention keys to @name in content text. */
export function isBotMentioned(content: string, botDisplayName: string): boolean {
  return content.includes("@" + botDisplayName);
}
