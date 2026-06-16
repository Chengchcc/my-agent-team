/**
 * M15.1: Send a plain text message directly to Lark — NO conversation ingest.
 * Used for system notifications like "已开启新的对话" that must not enter
 * the conversation ledger or pollute agent context.
 */

import { spawn } from "node:child_process";

export function sendTextOnly(
  profile: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "lark-cli",
      [
        "--profile",
        profile,
        "im",
        "+messages-send",
        "--chat-id",
        chatId,
        "--text",
        text,
        "--as",
        "bot",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

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
