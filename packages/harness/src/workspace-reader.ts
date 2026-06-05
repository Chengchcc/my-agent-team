import fs from "node:fs/promises";
import type { Logger } from "@my-agent-team/framework";

export async function readOrEmpty(filePath: string, logger: Logger): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    logger.warn(`harness: read ${filePath} failed: ${code ?? String(err)}`);
    return "";
  }
}
