import { spawn } from "node:child_process";

function sanitizeLarkCliError(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  return trimmed
    .replace(/app[_-]?secret\s*[:=]\s*\S+/gi, "appSecret=[redacted]")
    .replace(/secret\s*[:=]\s*\S+/gi, "secret=[redacted]")
    .replace(/token\s*[:=]\s*\S+/gi, "token=[redacted]")
    .slice(0, 500);
}

/**
 * Initialize a per-agent lark-cli profile.
 * appSecret is passed via stdin (never via argv) to avoid secret exposure.
 * Profile name follows the convention agent:<safeAgentId>.
 */
export async function larkProfileInit(
  profileRef: string,
  appId: string,
  appSecret: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "lark-cli",
      [
        "config",
        "init",
        "--name",
        profileRef,
        "--app-id",
        appId,
        "--app-secret-stdin",
        "--brand",
        "feishu",
      ],
      {
        stdio: ["pipe", "ignore", "pipe"],
      },
    );

    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`lark-cli config init failed to spawn: ${err.message}`));
    });

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`lark-cli config init exited ${code}: ${sanitizeLarkCliError(stderr)}`));
    });

    // Write secret via stdin, then close for non-interactive init
    child.stdin?.end(appSecret);
  });
}
