/**
 * Vendored from feishu-claude-code-bridge (MIT, 2025).
 * Source: https://github.com/zarazhangrui/feishu-claude-code-bridge/blob/main/src/bot/reaction.ts
 * Modifications: dropped doc-comment helpers; replaced FCCB log module with no-op.
 */
import type * as Lark from '@larksuiteoapi/node-sdk';

export async function addWorkingReaction(
  channel: Lark.LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  try {
    const r = (await channel.rawClient.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: 'Typing' } },
    })) as { data?: { reaction_id?: string } };
    return r?.data?.reaction_id;
  } catch {
    return undefined;
  }
}

export async function removeReaction(
  channel: Lark.LarkChannel,
  messageId: string,
  reactionId: string,
): Promise<void> {
  try {
    await channel.rawClient.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch { /* ignore */ }
}
