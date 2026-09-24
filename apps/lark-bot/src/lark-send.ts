import { spawn } from "node:child_process";

/** What every send path resolves to. The ids matter: without them a text
 *  answer cannot be audited (where did it land?), recorded as a topic key, or
 *  withdrawn — which is how a probe message once became unremovable. */
export interface LarkSendResult {
  ok: boolean;
  error?: string;
  messageId?: string;
  threadId?: string;
}

/** Send one message through lark-cli.
 *
 *  Replying to a message instead of posting into the chat is what puts an
 *  answer inside its Lark TOPIC (ADR 0037): `--message-id` names the topic's
 *  root, and `--reply-in-thread` is required inside a TOPIC chat — a normal
 *  chat rejects the flag, so the caller decides (it is the one that knows the
 *  chat's mode). Both send paths (plain notifications and the text bridge)
 *  go through here so the rule lives once. */
/** lark-cli prints the API response as JSON: `{ok, data:{message_id, thread_id}}`.
 *  Best effort — a missing/odd shape must not turn a delivered message into a
 *  reported failure. */
function parseSendOutput(stdout: string): { messageId?: string; threadId?: string } {
  const parsed = (() => {
    try {
      return JSON.parse(stdout.trim()) as unknown;
    } catch {
      return null;
    }
  })();
  if (typeof parsed !== "object" || parsed === null) return {};
  const data = "data" in parsed ? parsed.data : undefined;
  if (typeof data !== "object" || data === null) return {};
  const messageId = "message_id" in data ? data.message_id : undefined;
  const threadId = "thread_id" in data ? data.thread_id : undefined;
  return {
    ...(typeof messageId === "string" ? { messageId } : {}),
    ...(typeof threadId === "string" ? { threadId } : {}),
  };
}

export function sendViaLarkCli(input: {
  profile: string;
  chatId: string;
  text: string;
  /** Lark deduplicates on this key; omitted for one-shot notifications. */
  idempotencyKey?: string;
  /** The topic's root message id (`om_…`): reply there instead of to the chat. */
  replyTo?: string | null;
  replyInThread?: boolean;
}): Promise<LarkSendResult> {
  const args = ["--profile", input.profile, "im"];
  if (input.replyTo) {
    args.push("+messages-reply", "--message-id", input.replyTo, "--text", input.text);
    if (input.replyInThread) args.push("--reply-in-thread");
  } else {
    args.push("+messages-send", "--chat-id", input.chatId, "--text", input.text);
  }
  args.push("--as", "bot");
  if (input.idempotencyKey) args.push("--idempotency-key", input.idempotencyKey);

  const { promise, resolve } = Promise.withResolvers<LarkSendResult>();
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
    resolve({ ok: false, error: err.message });
  });
  child.on("exit", (code) => {
    if (code !== 0) {
      resolve({ ok: false, error: stderr.trim() || `exit code ${code}` });
      return;
    }
    resolve({ ok: true, ...parseSendOutput(stdout) });
  });
  return promise;
}
