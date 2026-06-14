/**
 * M15.1: Typing reaction lifecycle for immediate user feedback.
 * Uses lark-cli api POST/DELETE to add/remove Typing emoji on a message.
 * Failure is non-fatal — it never blocks ingest or run.
 */

import { spawn } from "node:child_process";

export interface LarkTypingReactionState {
  messageId: string;
  reactionId: string | null;
  startedAt: number;
  status: "none" | "active" | "removed" | "failed";
  lastError?: string;
}

/** Add a Typing reaction to a Lark message. Best-effort, never throws. */
export function addTypingReaction(profile: string, messageId: string): Promise<LarkTypingReactionState> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(
      "lark-cli",
      [
        "--profile",
        profile,
        "api",
        "POST",
        `/open-apis/im/v1/messages/${messageId}/reactions`,
        "--data",
        JSON.stringify({ reaction_type: { emoji_type: "Typing" } }),
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
      resolve({
        messageId,
        reactionId: null,
        startedAt,
        status: "failed",
        lastError: err.message,
      });
    });

    child.on("exit", (code) => {
      if (code === 0) {
        let reactionId: string | null = null;
        try {
          const parsed = JSON.parse(stdout);
          reactionId =
            (parsed as { data?: { reaction_id?: string } }).data?.reaction_id ??
            null;
        } catch { /* ignore parse errors */ }
        resolve({ messageId, reactionId, startedAt, status: "active" });
      } else {
        resolve({
          messageId,
          reactionId: null,
          startedAt,
          status: "failed",
          lastError: stderr.trim() || `exit code ${code}`,
        });
      }
    });
  });
}

/** Remove a Typing reaction. Best-effort, never throws. */
export function removeTypingReaction(
  profile: string,
  state: LarkTypingReactionState,
): Promise<void> {
  if (!state.reactionId) return Promise.resolve();

  return new Promise((resolve) => {
    const child = spawn(
      "lark-cli",
      [
        "--profile",
        profile,
        "api",
        "DELETE",
        `/open-apis/im/v1/messages/${state.messageId}/reactions/${state.reactionId}`,
        "--format",
        "json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}
