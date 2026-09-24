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
  sendCard(chatId: string, cardId: string): Promise<{ ok: true; messageId: string } | CardKitErr>;
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

    async sendCard(chatId, cardId) {
      const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
      const resp = await call("POST", "/open-apis/im/v1/messages?receive_id_type=chat_id", {
        receive_id: chatId,
        msg_type: "interactive",
        content,
      });
      const { envelope, result } = await parse(resp);
      if (!result.ok) return result;
      const messageId = (envelope.data as { message_id?: string } | undefined)?.message_id;
      if (typeof messageId !== "string" || !messageId) {
        return { ok: false, error: "no message_id in sendCard response", retryable: false };
      }
      return { ok: true, messageId };
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
