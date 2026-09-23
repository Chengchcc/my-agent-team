import { spawn } from "node:child_process";

/**
 * ADR 0031: send and update Lark interactive cards — pure outbound via
 * lark-cli, resurrected from the M15.1 implementation (git ae005601^).
 * sendCard: `im +messages-send --msg-type interactive`
 * updateCard: `api PATCH /open-apis/im/v1/messages/<id>`
 */

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

export type CardSendResult = CardSendOk | CardSendErr;

function runLarkCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("lark-cli", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function isRetryable(stderr: string): boolean {
  return /429|5\d\d/.test(stderr) || stderr.includes("rate_limit") || stderr.includes("RateLimit");
}

/** Send an interactive card; resolves the open_message_id on success. */
export async function sendCard(input: {
  profile: string;
  chatId: string;
  card: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<CardSendResult> {
  const { code, stdout, stderr } = await runLarkCli([
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
  ]);
  if (code !== 0) {
    return {
      ok: false,
      error: stderr.trim() || `exit code ${code}`,
      retryable: isRetryable(stderr),
    };
  }
  try {
    const raw: unknown = JSON.parse(stdout);
    const messageId =
      (raw as { data?: { message_id?: string } })?.data?.message_id ??
      (raw as { message_id?: string })?.message_id ??
      "";
    if (messageId) return { ok: true, messageId, raw };
    return { ok: false, error: `no message_id in: ${stdout.slice(0, 200)}`, retryable: false };
  } catch {
    const messageId = stdout.trim();
    if (messageId) return { ok: true, messageId };
    return { ok: false, error: `unparseable output: ${stdout.slice(0, 200)}`, retryable: false };
  }
}

/** Update an existing card by PATCHing the full card JSON. */
export async function updateCard(input: {
  profile: string;
  messageId: string;
  card: Record<string, unknown>;
}): Promise<{ ok: true; raw?: unknown } | CardSendErr> {
  const { code, stdout, stderr } = await runLarkCli([
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
  ]);
  if (code !== 0) {
    return {
      ok: false,
      error: stderr.trim() || `exit code ${code}`,
      retryable: isRetryable(stderr),
    };
  }
  try {
    return { ok: true, raw: JSON.parse(stdout) as unknown };
  } catch {
    return { ok: true, raw: stdout };
  }
}
