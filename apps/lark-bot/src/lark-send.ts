import { spawn } from "node:child_process";

/** What every send path resolves to. */
export interface LarkSendResult {
  ok: boolean;
  error?: string;
}

/** Send one message through lark-cli.
 *
 *  Replying to a message instead of posting into the chat is what puts an
 *  answer inside its Lark TOPIC (ADR 0037): `--message-id` names the topic's
 *  root, and `--reply-in-thread` is required inside a TOPIC chat — a normal
 *  chat rejects the flag, so the caller decides (it is the one that knows the
 *  chat's mode). Both send paths (plain notifications and the text bridge)
 *  go through here so the rule lives once. */
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
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  child.on("error", (err) => {
    resolve({ ok: false, error: err.message });
  });
  child.on("exit", (code) => {
    if (code === 0) resolve({ ok: true });
    else resolve({ ok: false, error: stderr.trim() || `exit code ${code}` });
  });
  return promise;
}
