/**
 * M15.1: Send a plain text message directly to Lark — NO conversation ingest.
 * Used for system notifications like "已开启新的对话" that must not enter
 * the conversation ledger or pollute agent context.
 */

import { type LarkSendResult, sendViaLarkCli } from "./lark-send.js";

export function sendTextOnly(
  profile: string,
  chatId: string,
  text: string,
  opts: { replyTo?: string | null; replyInThread?: boolean; toUserId?: string } = {},
): Promise<LarkSendResult> {
  return sendViaLarkCli({
    profile,
    chatId,
    text,
    ...(opts.toUserId ? { toUserId: opts.toUserId } : {}),
    replyTo: opts.replyTo,
    replyInThread: opts.replyInThread,
  });
}
