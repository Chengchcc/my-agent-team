import { spawn } from "node:child_process";
import { safeAgentId } from "./safe-agent-id.js";

/**
 * Send a message to a Lark chat via lark-cli.
 * Uses --idempotency-key to let Lark deduplicate.
 * Returns a promise that resolves when the send completes.
 */
export function sendMessage(
  agentId: string,
  larkChatId: string,
  text: string,
  idempotencyKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const profile = `agent:${safeAgentId(agentId)}`;

  return new Promise((resolve) => {
    const child = spawn("lark-cli", [
      "--profile",
      profile,
      "im",
      "+messages-send",
      "--chat-id",
      larkChatId,
      "--text",
      text,
      "--as",
      "bot",
      "--idempotency-key",
      idempotencyKey,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: stderr.trim() || `exit code ${code}` });
      }
    });
  });
}
