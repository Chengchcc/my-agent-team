import type { TokenProvider } from "../lark-api.js";

/**
 * ADR 0031: CardKit streaming client — direct HTTPS on the hot path.
 *
 * lark-cli owns profiles/credentials/inbound events and plain-text sends;
 * per-character card updates must NOT spawn a CLI per call. This client
 * speaks the CardKit OpenAPI with a tenant token from the TokenProvider:
 *
 *  1. createCard     POST /open-apis/cardkit/v1/cards — the card JSON MUST
 *     carry config.streaming_mode=true + update_multi:true
 *  2. sendCard       POST /open-apis/im/v1/messages with a
 *     {"type":"card","data":{"card_id"}} content reference
 *  3. streamElement  PUT .../cards/:id/elements/:element_id/content —
 *     cumulative text + a strictly increasing sequence; prefix-extended
 *     content renders the appended part with a client-side typewriter
 *  4. updateCard     PUT .../cards/:id — full replace (the ONLY way to
 *     move the header mid-run, and the terminal freeze)
 *  5. closeStreaming PATCH .../cards/:id/settings — after the terminal
 *     replace, restores normal card behaviour (the client leaves the
 *     streaming view)
 *
 * Constraints (Feishu docs): same app identity that created the card;
 * content ≤ 100k chars; keep the card under ~30KB; card entity lives 14d.
 */

export interface CardKitErr {
  ok: false;
  error: string;
  /** Rate-limit class: the caller's throttle should back off. */
  retryable: boolean;
}

export type CardKitResult = { ok: true } | CardKitErr;

interface ApiEnvelope {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

export interface CardKitClient {
  createCard(card: Record<string, unknown>): Promise<{ ok: true; cardId: string } | CardKitErr>;
  /** `opts.replyTo` names the TOPIC's root message: the card then answers
   *  inside that topic instead of appearing in the chat's main stream (ADR
   *  0037). `replyInThread` is only legal in a topic chat — a normal chat
   *  rejects it — so the caller passes it from the chat's known mode. */
  sendCard(
    chatId: string,
    cardId: string,
    opts?: { replyTo?: string | null; replyInThread?: boolean },
  ): Promise<{ ok: true; messageId: string; threadId?: string } | CardKitErr>;
  /** The chat's `chat_mode` ("group" | "topic"), for reply targeting. */
  getChatMode(chatId: string): Promise<string | null>;
  streamElement(input: {
    cardId: string;
    elementId: string;
    content: string;
    sequence: number;
    uuid: string;
  }): Promise<CardKitResult>;
  updateCard(
    cardId: string,
    card: Record<string, unknown>,
    sequence: number,
  ): Promise<CardKitResult>;
  closeStreaming(cardId: string, sequence: number): Promise<CardKitResult>;
  /** Emoji reaction on a message. Lives here because it is the same hot
   *  path (direct HTTPS, tenant token, 401 retry), not because it is a card
   *  API: Feishu has no typing indicator, so the bot acknowledges the user's
   *  message with a reaction while the card is being produced. */
  addReaction(
    messageId: string,
    emojiType: string,
  ): Promise<{ ok: true; reactionId: string } | CardKitErr>;
  removeReaction(messageId: string, reactionId: string): Promise<CardKitResult>;
}

export function createCardKitClient(tokens: TokenProvider): CardKitClient {
  async function rawCall(
    base: string,
    token: string,
    method: string,
    path: string,
    body: unknown,
  ): Promise<Response> {
    return fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  /** One authorized call; retries once with a fresh token on rejection. */
  async function call(method: string, path: string, body: unknown): Promise<Response> {
    const token = await tokens.getToken();
    const first = await rawCall(tokens.getBaseUrl(), token, method, path, body);
    const envelope = (await first
      .clone()
      .json()
      .catch(() => ({}))) as ApiEnvelope;
    const tokenRejected = first.status === 401 || envelope.code === 99991663;
    if (!tokenRejected) return first;
    tokens.invalidate();
    const fresh = await tokens.getToken();
    return rawCall(tokens.getBaseUrl(), fresh, method, path, body);
  }

  async function parse(resp: Response): Promise<{ envelope: ApiEnvelope; result: CardKitResult }> {
    if (resp.status === 429 || resp.status >= 500) {
      return { envelope: {}, result: { ok: false, error: `HTTP ${resp.status}`, retryable: true } };
    }
    const envelope = (await resp.json().catch(() => ({}))) as ApiEnvelope;
    if (typeof envelope.code === "number" && envelope.code !== 0) {
      return {
        envelope,
        result: {
          ok: false,
          error: `code ${envelope.code}: ${envelope.msg ?? ""}`.trim(),
          retryable: envelope.code === 230020,
        },
      };
    }
    return { envelope, result: { ok: true } };
  }

  return {
    async addReaction(messageId, emojiType) {
      const resp = await call(
        "POST",
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        { reaction_type: { emoji_type: emojiType } },
      );
      const { envelope, result } = await parse(resp);
      if (!result.ok) return result;
      const reactionId = envelope.data?.reaction_id;
      if (typeof reactionId !== "string" || !reactionId) {
        return { ok: false, error: "no reaction_id in addReaction response", retryable: false };
      }
      return { ok: true, reactionId };
    },
    async removeReaction(messageId, reactionId) {
      const resp = await call(
        "DELETE",
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
        undefined,
      );
      return (await parse(resp)).result;
    },
    async createCard(card) {
      const resp = await call("POST", "/open-apis/cardkit/v1/cards", {
        type: "card_json",
        data: JSON.stringify(card),
      });
      const { envelope, result } = await parse(resp);
      if (!result.ok) return result;
      const cardId = envelope.data?.card_id;
      if (typeof cardId !== "string" || !cardId) {
        return { ok: false, error: "no card_id in createCard response", retryable: false };
      }
      return { ok: true, cardId };
    },

    async getChatMode(chatId) {
      const resp = await call(
        "GET",
        `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
        undefined,
      );
      const { envelope, result } = await parse(resp);
      if (!result.ok) return null;
      const data = envelope.data;
      if (typeof data !== "object" || data === null) return null;
      // No cast: `in` narrows the unknown envelope to a shape with the field.
      if (!("chat_mode" in data)) return null;
      return typeof data.chat_mode === "string" ? data.chat_mode : null;
    },

    async sendCard(chatId, cardId, opts) {
      const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
      const replyTo = opts?.replyTo ?? null;
      // Replying to the topic's root is what keeps question and answer in the
      // same topic; `reply_in_thread` is what makes a TOPIC chat show it in
      // the topic at all (without it the card lands in the main stream).
      const path = replyTo
        ? `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`
        : "/open-apis/im/v1/messages?receive_id_type=chat_id";
      const body: Record<string, unknown> = { msg_type: "interactive", content };
      if (replyTo) {
        if (opts?.replyInThread === true) body.reply_in_thread = true;
      } else {
        body.receive_id = chatId;
      }
      const resp = await call("POST", path, body);
      const { envelope, result } = await parse(resp);
      if (!result.ok) return result;
      const data = envelope.data;
      const messageId =
        typeof data === "object" &&
        data !== null &&
        "message_id" in data &&
        typeof data.message_id === "string"
          ? data.message_id
          : undefined;
      if (typeof messageId !== "string" || !messageId) {
        return { ok: false, error: "no message_id in sendCard response", retryable: false };
      }
      // A thread reply comes back with the topic id the platform assigned
      // (probed): returning it lets the caller map that topic to this
      // conversation immediately, instead of waiting for the next user reply
      // to arrive carrying it.
      const threadId =
        typeof data === "object" &&
        data !== null &&
        "thread_id" in data &&
        typeof data.thread_id === "string"
          ? data.thread_id
          : undefined;
      return threadId ? { ok: true, messageId, threadId } : { ok: true, messageId };
    },

    async streamElement({ cardId, elementId, content, sequence, uuid }) {
      const resp = await call(
        "PUT",
        `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
        { uuid, content, sequence },
      );
      const { result } = await parse(resp);
      return result;
    },

    async updateCard(cardId, card, sequence) {
      const resp = await call("PUT", `/open-apis/cardkit/v1/cards/${cardId}`, {
        card: { type: "card_json", data: JSON.stringify(card) },
        sequence,
      });
      const { result } = await parse(resp);
      return result;
    },

    async closeStreaming(cardId, sequence) {
      const resp = await call("PATCH", `/open-apis/cardkit/v1/cards/${cardId}/settings`, {
        settings: JSON.stringify({ streaming_mode: false }),
        sequence,
      });
      const { result } = await parse(resp);
      return result;
    },
  };
}
