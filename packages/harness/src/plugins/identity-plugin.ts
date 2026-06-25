import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";
import { todayAndYesterday } from "../daily-log.js";
import { composeSystemPrompt } from "../system-prompt.js";

export interface IdentityPluginOptions {
  cwd: string;
}

// BOOTSTRAP_TEMPLATE from bootstrap.ts — used when no SOUL.md exists
export const BOOTSTRAP_TEMPLATE = `You are a new agent. This is your genesis moment.

Your first task is to understand who you are and what you can do. Read the tools available to you and the system context. Then:

1. Create your SOUL.md — define your personality, principles, and working style
2. Create your USER.md — describe what you know about your user so far
3. Create memory/MEMORY.md — start your memory index
4. Create AGENTS.md — if you need to coordinate with other agents
5. Create TOOLS.md — document any tool usage patterns you discover

Use the write tool to create these files in your workspace directory.`;

/**
 * identityPlugin — reads identity files from cwd and injects system prompt.
 * Handles genesis mode (BOOTSTRAP_TEMPLATE) when no SOUL.md exists.
 */
export function identityPlugin(opts: IdentityPluginOptions): Plugin {
  const { cwd } = opts;

  function readFile(path: string): string | null {
    try {
      const full = join(cwd, path);
      if (!existsSync(full)) return null;
      return readFileSync(full, "utf-8");
    } catch {
      return null;
    }
  }

  return {
    name: "identity",
    hooks: {
      async beforeModel(_ctx, messages: Message[]): Promise<Message[]> {
        const { today, yesterday } = todayAndYesterday();

        // Ensure memory directory exists
        const memoryDir = join(cwd, "memory");
        if (!existsSync(memoryDir)) {
          try {
            mkdirSync(memoryDir, { recursive: true });
          } catch {
            // best-effort
          }
        }

        const bootstrap = readFile("BOOTSTRAP.md");
        const soul = readFile("SOUL.md");

        if (!soul) {
          // Genesis mode: inject BOOTSTRAP_TEMPLATE
          const template = bootstrap ?? BOOTSTRAP_TEMPLATE;
          return [{ role: "system", text: template }, ...messages];
        }

        // Normal mode: compose full system prompt
        const [userDoc, toolsDoc, agentsDoc, todayLog, yestLog] = await Promise.all([
          Promise.resolve(readFile("USER.md")),
          Promise.resolve(readFile("TOOLS.md")),
          Promise.resolve(readFile("AGENTS.md")),
          Promise.resolve(readFile(`memory/${today}.md`)),
          Promise.resolve(readFile(`memory/${yesterday}.md`)),
        ]);

        const prompt = composeSystemPrompt({
          soul,
          user: userDoc ?? "",
          tools: toolsDoc ?? "",
          agents: agentsDoc ?? "",
          todayLog: todayLog ?? "",
          yestLog: yestLog ?? "",
          today,
          yesterday,
        });

        return [{ role: "system", text: prompt }, ...messages];
      },
    },
  };
}
