/**
 * Minimal FakeLarkClient — stubs HTTP calls the LarkBotAdapter makes.
 * Does NOT extend the real LarkClient; just duck-types the methods adapter uses.
 */
export class FakeLarkClient {
  sentMessages: Array<{ chatId: string; content: string; msgType: string; messageId: string }> = []
  repliedMessages: Array<{ messageId: string; content: string; msgType: string; replyMessageId: string }> = []

  async sendMessage(chatId: string, content: string, msgType: string = 'text'): Promise<string> {
    const messageId = `m-${Date.now()}`
    this.sentMessages.push({ chatId, content, msgType, messageId })
    return messageId
  }

  async replyMessage(
    messageId: string, content: string, msgType: string = 'text',
    _replyInThread: boolean = false,
  ): Promise<string> {
    const replyMessageId = `rm-${Date.now()}`
    this.repliedMessages.push({ messageId, content, msgType, replyMessageId })
    return replyMessageId
  }

  close(): void { /* noop */ }
}
