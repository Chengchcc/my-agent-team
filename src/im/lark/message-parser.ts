// src/im/lark/message-parser.ts

export interface ParsedMessage {
  messageId: string;
  chatId: string;
  rootId?: string;
  threadId?: string;
  senderId?: string;
  senderType: 'user' | 'app' | 'unknown';
  chatType: 'group' | 'p2p';
  msgType: string;
  content: string;
  mentions: LarkMention[];
  createTime: string;
}

export interface LarkMention {
  key: string;
  name: string;
  openId?: string;
}

function resolveMentionPlaceholders(content: string, mentions: LarkMention[]): string {
  let result = content;
  for (const m of mentions) {
    if (m.key && m.name) {
      result = result.split(m.key).join(`@${m.name}`);
    }
  }
  return result;
}

function extractMessageContent(message: Record<string, unknown>): string {
  const msgType: string = String(message.msg_type ?? 'text');

  // Non-text message types — return placeholder
  if (msgType === 'image') return '[图片]';
  if (msgType === 'audio') return '[语音]';
  if (msgType === 'sticker') return '[表情]';
  if (msgType === 'file') {
    try {
      const obj = JSON.parse(String(message.content ?? '{}'));
      const fileName = typeof obj.file_name === 'string' ? obj.file_name : 'file';
      return `[文件:${fileName}]`;
    } catch { return '[文件:file]'; }
  }

  try {
    const obj = JSON.parse(String(message.content ?? '{}'));
    if (msgType === 'text' && typeof obj.text === 'string') {
      return obj.text;
    }
    // post type — extract text from nested paragraphs
    const inner = obj.zh_cn ?? obj.en_us ?? obj;
    if (Array.isArray(inner?.content)) {
      const parts: string[] = [];
      for (const para of inner.content) {
        if (!Array.isArray(para)) continue;
        for (const node of para) {
          if (typeof node === 'object' && node !== null && 'tag' in node && node.tag === 'text' && typeof node.text === 'string') {
            parts.push(node.text);
          }
        }
      }
      return parts.join('');
    }
  } catch { /* empty content */ }
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseEventMessage(data: any): ParsedMessage {
  const message = data.message ?? data;
  const sender = data.sender;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mentions: LarkMention[] = (message.mentions ?? []).map((m: any) => ({
    key: m.key ?? '',
    name: m.name ?? '',
    openId: m.id?.open_id,
  }));

  const msgType: string = message.msg_type ?? 'text';
  const rawContent = extractMessageContent(message);
  const content = resolveMentionPlaceholders(rawContent, mentions);

  return {
    messageId: message.message_id ?? '',
    chatId: message.chat_id ?? '',
    rootId: message.root_id,
    threadId: message.thread_id,
    senderId: sender?.sender_id?.open_id,
    senderType: sender?.sender_type === 'app' ? 'app' : sender?.sender_type === 'user' ? 'user' : 'unknown',
    chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
    msgType,
    content: content.trim(),
    mentions,
    createTime: message.create_time ?? '',
  };
}

export function stripLeadingMentions(content: string, mentions: LarkMention[]): string {
  let result = content;
  for (const m of mentions) {
    const atName = `@${m.name}`;
    if (result.startsWith(atName)) {
      result = result.slice(atName.length).trimStart();
    }
  }
  return result;
}
