import path from "node:path";
import type { Logger } from "@my-agent-team/framework";
import { todayAndYesterday } from "./daily-log.js";
import { fallbackSystemPrompt } from "./fallback-prompt.js";
import { composeSystemPrompt } from "./system-prompt.js";
import { readOrEmpty } from "./workspace-reader.js";

export async function bootstrap(workspace: string, logger: Logger): Promise<string> {
  const { today, yesterday } = todayAndYesterday();

  // Parallel read 6 files (Q14 = A)
  const [soul, user, tools, agents, todayLog, yestLog] = await Promise.all([
    readOrEmpty(path.join(workspace, "SOUL.md"), logger),
    readOrEmpty(path.join(workspace, "USER.md"), logger),
    readOrEmpty(path.join(workspace, "TOOLS.md"), logger),
    readOrEmpty(path.join(workspace, "AGENTS.md"), logger),
    readOrEmpty(path.join(workspace, "memory", `${today}.md`), logger),
    readOrEmpty(path.join(workspace, "memory", `${yesterday}.md`), logger),
  ]);

  // All empty (or whitespace-only) → fallback prompt (Q7 = A)
  if (
    !soul.trim() &&
    !user.trim() &&
    !tools.trim() &&
    !agents.trim() &&
    !todayLog.trim() &&
    !yestLog.trim()
  ) {
    return fallbackSystemPrompt(workspace);
  }

  return composeSystemPrompt({ soul, user, tools, agents, today, yesterday, todayLog, yestLog });
}
