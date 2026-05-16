// src/im/lark/client.ts
import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const CHAT_MODE_TTL_MINUTES = 5;
const CHAT_MODE_TTL_MS = CHAT_MODE_TTL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;
const TOKEN_EXPIRE_SECONDS = 7200;
const TOKEN_REFRESH_THRESHOLD_MS = 60_000;

export class LarkClient {
  private client: Client;
  private readonly _appSecret: string;
  readonly appSecretHash: string;
  private chatModeCache = new Map<string, { mode: 'group' | 'topic' | 'p2p'; cachedAt: number }>();
  private tokenCache: { token: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;

  constructor(
    public readonly appId: string,
    appSecret: string,
  ) {
    this._appSecret = appSecret;
    this.client = new Client({
      appId,
      appSecret,
      loggerLevel: process.env.DEBUG ? LoggerLevel.info : LoggerLevel.warn,
    });
    this.appSecretHash = sha256(appSecret);
  }

  // ── Single-flight token (#26 fix) ────────────────────────────────────

  private async getToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - TOKEN_REFRESH_THRESHOLD_MS) {
      return this.tokenCache.token;
    }
    if (this.tokenInFlight) return this.tokenInFlight;
    this.tokenInFlight = this.fetchToken().finally(() => { this.tokenInFlight = null; });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const tokenRes = await fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this._appSecret }),
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenData = await tokenRes.json() as any;
    if (tokenData.code !== 0) throw new Error(`Failed to get token: ${tokenData.msg}`);
    this.tokenCache = {
      token: tokenData.tenant_access_token,
      expiresAt: Date.now() + (tokenData.expire ?? TOKEN_EXPIRE_SECONDS) * MS_PER_SECOND,
    };
    return this.tokenCache.token;
  }

  // ── Message APIs ─────────────────────────────────────────────────────

  async sendMessage(
    chatId: string, content: string, msgType: string = 'text',
  ): Promise<string> {
    const body = msgType === 'text' ? JSON.stringify({ text: content }) : content;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (this.client.im.v1.message as any).create({
      params: { receive_id_type: 'chat_id' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { receive_id: chatId, msg_type: msgType as any, content: body },
    });
    if (res.code !== 0) throw new Error(`sendMessage failed: ${res.msg} (code: ${res.code})`);
    return res.data?.message_id ?? '';
  }

  async replyMessage(
    messageId: string, content: string, msgType: string = 'text',
    replyInThread: boolean = false,
  ): Promise<string> {
    const body = msgType === 'text' ? JSON.stringify({ text: content }) : content;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (this.client.im.v1.message as any).reply({
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

  async updateMessage(
    messageId: string, cardJson: string,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (this.client.im.v1.message as any).patch({
      path: { message_id: messageId },
      data: { content: cardJson },
    });
    if (res.code !== 0) throw new Error(`updateMessage failed: ${res.msg} (code: ${res.code})`);
  }

  // ── Chat APIs ────────────────────────────────────────────────────────

  async getChatInfo(
    chatId: string,
  ): Promise<{ userCount: number; botCount: number }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (this.client.im.v1.chat as any).get({ path: { chat_id: chatId } });
    if (res.code !== 0) throw new Error(`getChatInfo failed: ${res.msg} (code: ${res.code})`);
    return {
      userCount: Number(res.data?.user_count ?? 0),
      botCount: Number(res.data?.bot_count ?? 0),
    };
  }

  async getChatMode(
    chatId: string, opts: { forceRefresh?: boolean } = {},
  ): Promise<'group' | 'topic' | 'p2p'> {
    const key = `${this.appId}::${chatId}`;
    const cached = this.chatModeCache.get(key);
    if (!opts.forceRefresh && cached && Date.now() - cached.cachedAt < CHAT_MODE_TTL_MS) {
      return cached.mode;
    }
    let mode: 'group' | 'topic' | 'p2p' = 'group';
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (this.client.im.v1.chat as any).get({ path: { chat_id: chatId } });
      if (res.code === 0) {
        const rawMode = String(res.data?.chat_mode ?? '').toLowerCase();
        const rawType = String(res.data?.chat_type ?? '').toLowerCase();
        const rawGmt = String(res.data?.group_message_type ?? '').toLowerCase();
        if (rawType === 'p2p') mode = 'p2p';
        else if (rawMode === 'topic' || rawGmt === 'thread') mode = 'topic';
        else mode = 'group';
      }
    } catch { /* fallback to 'group' */ }
    this.chatModeCache.set(key, { mode, cachedAt: Date.now() });
    return mode;
  }

  invalidateChatModeCache(chatId: string): void {
    this.chatModeCache.delete(`${this.appId}::${chatId}`);
  }

  // ── Bot identity ─────────────────────────────────────────────────────

  async getBotOpenId(): Promise<{ openId: string; name: string }> {
    const token = await this.getToken();
    const botRes = await fetch('https://open.feishu.cn/open-apis/bot/v3/info/', {
      headers: { Authorization: `Bearer ${token}` },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const botData = await botRes.json() as any;
    if (botData.code !== 0) throw new Error(`Failed to get bot info: ${botData.msg}`);
    return { openId: botData.bot?.open_id, name: botData.bot?.app_name ?? '' };
  }

  // ── Message details ──────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getMessageDetail(messageId: string): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (this.client.im.v1.message as any).get({
      path: { message_id: messageId },
      params: { card_msg_content_type: 'user_card_content' },
    });
    if (res.code !== 0) throw new Error(`getMessageDetail failed: ${res.msg}`);
    return res.data;
  }

  async downloadResource(
    messageId: string, fileKey: string, type: 'image' | 'file', savePath: string,
  ): Promise<void> {
    const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (this.client.im.v1.messageResource as any).get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    const dir = dirname(savePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (res instanceof Buffer) {
      writeFileSync(savePath, res);
    } else if (res && typeof res === 'object' && 'writeFile' in res) {
      await (res as { writeFile: (p: string) => Promise<void> }).writeFile(savePath);
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of res as AsyncIterable<Buffer>) {
        chunks.push(Buffer.from(chunk));
      }
      writeFileSync(savePath, Buffer.concat(chunks));
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  close(): void {
    // Clean up resources if needed in the future
  }
}

// ── Factory ────────────────────────────────────────────────────────────

const clients = new Map<string, LarkClient>();

export function getLarkClient(appId: string, appSecret: string): LarkClient {
  const existing = clients.get(appId);
  if (existing) {
    if (existing.appSecretHash !== sha256(appSecret)) {
      throw new Error(`[lark] appSecret mismatch for appId=${appId}`);
    }
    return existing;
  }
  const c = new LarkClient(appId, appSecret);
  clients.set(appId, c);
  return c;
}

export async function closeAllLarkClients(): Promise<void> {
  for (const c of clients.values()) c.close();
  clients.clear();
}
