// src/im/lark/client.ts
import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';

let _client: InstanceType<typeof Client> | null = null;
let _appId = '';
let _appSecret = '';

export function initLarkClient(appId: string, appSecret: string): void {
  _appId = appId;
  _appSecret = appSecret;
  _client = new Client({
    appId,
    appSecret,
    loggerLevel: process.env.DEBUG ? LoggerLevel.info : LoggerLevel.warn,
  });
}

function client(): InstanceType<typeof Client> {
  if (!_client) throw new Error('Lark client not initialized');
  return _client;
}

export async function sendMessage(
  chatId: string, content: string, msgType: string = 'text',
): Promise<string> {
  const c = client();
  const body = msgType === 'text' ? JSON.stringify({ text: content }) : content;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (c.im.v1.message as any).create({
    params: { receive_id_type: 'chat_id' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { receive_id: chatId, msg_type: msgType as any, content: body },
  });
  if (res.code !== 0) throw new Error(`sendMessage failed: ${res.msg} (code: ${res.code})`);
  return res.data?.message_id ?? '';
}

export async function replyMessage(
  messageId: string, content: string, msgType: string = 'text',
  replyInThread: boolean = false,
): Promise<string> {
  const c = client();
  const body = msgType === 'text' ? JSON.stringify({ text: content }) : content;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (c.im.v1.message as any).reply({
    path: { message_id: messageId },
    data: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      msg_type: msgType as any,
      content: body,
      ...(replyInThread ? { reply_in_thread: true } : {}),
    },
  });
  if (res.code !== 0) throw new Error(`replyMessage failed: ${res.msg} (code: ${res.code})`);
  return res.data?.message_id ?? '';
}

export async function updateMessage(
  messageId: string, cardJson: string,
): Promise<void> {
  const c = client();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (c.im.v1.message as any).patch({
    path: { message_id: messageId },
    data: { content: cardJson },
  });
  if (res.code !== 0) throw new Error(`updateMessage failed: ${res.msg} (code: ${res.code})`);
}

export async function getChatInfo(
  chatId: string,
): Promise<{ userCount: number; botCount: number }> {
  const c = client();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (c.im.v1.chat as any).get({ path: { chat_id: chatId } });
  if (res.code !== 0) throw new Error(`getChatInfo failed: ${res.msg} (code: ${res.code})`);
  return {
    userCount: Number(res.data?.user_count ?? 0),
    botCount: Number(res.data?.bot_count ?? 0),
  };
}

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const CHAT_MODE_TTL_MINUTES = 5;
const CHAT_MODE_TTL_MS = CHAT_MODE_TTL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

const chatModeCache = new Map<string, { mode: 'group' | 'topic' | 'p2p'; cachedAt: number }>();

export async function getChatMode(
  chatId: string, opts: { forceRefresh?: boolean } = {},
): Promise<'group' | 'topic' | 'p2p'> {
  const key = `${_appId}::${chatId}`;
  const cached = chatModeCache.get(key);
  if (!opts.forceRefresh && cached && Date.now() - cached.cachedAt < CHAT_MODE_TTL_MS) {
    return cached.mode;
  }
  let mode: 'group' | 'topic' | 'p2p' = 'group';
  try {
    const c = client();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (c.im.v1.chat as any).get({ path: { chat_id: chatId } });
    if (res.code === 0) {
      const rawMode = String(res.data?.chat_mode ?? '').toLowerCase();
      const rawType = String(res.data?.chat_type ?? '').toLowerCase();
      const rawGmt = String(res.data?.group_message_type ?? '').toLowerCase();
      if (rawType === 'p2p') mode = 'p2p';
      else if (rawMode === 'topic' || rawGmt === 'thread') mode = 'topic';
      else mode = 'group';
    }
  } catch { /* fallback to 'group' */ }
  chatModeCache.set(key, { mode, cachedAt: Date.now() });
  return mode;
}

export async function getBotOpenId(): Promise<{ openId: string; name: string }> {
  const tokenRes = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: _appId, app_secret: _appSecret }),
    },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokenData = await tokenRes.json() as any;
  if (tokenData.code !== 0) throw new Error(`Failed to get token: ${tokenData.msg}`);

  const botRes = await fetch('https://open.feishu.cn/open-apis/bot/v3/info/', {
    headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const botData = await botRes.json() as any;
  if (botData.code !== 0) throw new Error(`Failed to get bot info: ${botData.msg}`);
  return { openId: botData.bot?.open_id, name: botData.bot?.app_name ?? '' };
}

