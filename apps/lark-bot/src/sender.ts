import { type LarkSendResult, sendViaLarkCli } from "./lark-send.js";

/**
 * Send a message to a Lark chat (or into a topic) via lark-cli.
 * Uses --idempotency-key to let Lark deduplicate.
 */
export function sendMessage(
  profile: string,
  larkChatId: string,
  text: string,
  idempotencyKey: string,
  opts: { replyTo?: string | null; replyInThread?: boolean } = {},
): Promise<LarkSendResult> {
  return sendViaLarkCli({
    profile,
    chatId: larkChatId,
    text,
    idempotencyKey,
    replyTo: opts.replyTo,
    replyInThread: opts.replyInThread,
  });
}
