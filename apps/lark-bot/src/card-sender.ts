/**
 * M15.1: Send and update interactive Lark cards for streaming agent output.
 * sendCard: lark-cli im +messages-send --msg-type interactive
 * updateCard: lark-cli api PATCH /open-apis/im/v1/messages/<id>
 */

import { spawn } from "node:child_process";

export interface CardSendOk {
  ok: true;
  messageId: string;
  raw?: unknown;
}

export interface CardSendErr {
  ok: false;
  error: string;
  retryable: boolean;
}

/** Send an interactive card to a Lark chat. Returns the open_message_id on success. */
export function sendCard(input: {
  profile: string;
  chatId: string;
  card: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<CardSendOk | CardSendErr> {
  return new Promise((resolve) => {
    const child = spawn(
      "lark-cli",
      [
        "--profile",
        input.profile,
        "im",
        "+messages-send",
        "--chat-id",
        input.chatId,
        "--msg-type",
        "interactive",
        "--content",
        JSON.stringify(input.card),
        "--as",
        "bot",
        "--idempotency-key",
        input.idempotencyKey,
        "--format",
        "json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", (err) => {
      resolve({ ok: false, error: err.message, retryable: true });
    });

    child.on("exit", (code) => {
      if (code === 0) {
        let raw: unknown;
        let messageId = "";
        try {
          raw = JSON.parse(stdout);
          messageId =
            (raw as { data?: { message_id?: string } })?.data?.message_id ??
            (raw as { message_id?: string })?.message_id ??
            "";
        } catch {
          messageId = stdout.trim();
        }
        if (messageId) {
          resolve({ ok: true, messageId, raw });
        } else {
          resolve({ ok: false, error: `no message_id in: ${stdout.slice(0, 200)}`, retryable: false });
        }
      } else {
        // 429 / 5xx are retryable
        const retryable = /429|5\d\d/.test(stderr) || stderr.includes("rate_limit") || stderr.includes("RateLimit");
        resolve({ ok: false, error: stderr.trim() || `exit code ${code}`, retryable });
      }
    });
  });
}

/** Update an existing card by PATCHing the full card JSON. */
export function updateCard(input: {
  profile: string;
  messageId: string;
  card: Record<string, unknown>;
}): Promise<{ ok: true; raw?: unknown } | CardSendErr> {
  return new Promise((resolve) => {
    const child = spawn(
      "lark-cli",
      [
        "--profile",
        input.profile,
        "api",
        "PATCH",
        `/open-apis/im/v1/messages/${input.messageId}`,
        "--as",
        "bot",
        "--params",
        JSON.stringify({ message_id_type: "open_message_id" }),
        "--data",
        JSON.stringify({ content: JSON.stringify(input.card) }),
        "--format",
        "json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", (err) => {
      resolve({ ok: false, error: err.message, retryable: true });
    });

    child.on("exit", (code) => {
      if (code === 0) {
        let raw: unknown;
        try { raw = JSON.parse(stdout); } catch { raw = stdout; }
        resolve({ ok: true, raw });
      } else {
        const retryable = /429|5\d\d/.test(stderr) || stderr.includes("rate_limit") || stderr.includes("RateLimit");
        resolve({ ok: false, error: stderr.trim() || `exit code ${code}`, retryable });
      }
    });
  });
}
