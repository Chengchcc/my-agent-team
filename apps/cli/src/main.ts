import path from "node:path";
import * as readline from "node:readline/promises";
import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
import { type Message, run } from "@my-agent-team/core";
import type { Agent, AgentEvent } from "@my-agent-team/framework";
import {
  createMemoryRecallTool,
  createMemorySaveTool,
  createWebSearchTool,
  readTool,
  webFetchTool,
  writeTool,
} from "@my-agent-team/tools-common";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY environment variable required");
  process.exit(1);
}

const args = process.argv.slice(2);
const modelArg = args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? "claude-opus-4-7";
const maxStepsArg = args.find((a) => a.startsWith("--max-steps="))?.split("=")[1] ?? "32";
const systemArg = args.find((a) => a.startsWith("--system="))?.split("=")[1];
const workspaceArg = args.find((a) => a.startsWith("--workspace="))?.split("=")[1];

const model = new AnthropicChatModel({ apiKey: ANTHROPIC_API_KEY, model: modelArg });

function renderEvent(event: AgentEvent): void {
  if (event.type !== "message") return;
  const msg = event.payload;
  const blocks = typeof msg.content === "string" ? msg.content : msg.content;

  if (msg.role === "assistant") {
    if (typeof blocks === "string") {
      process.stdout.write(blocks);
    } else {
      for (const block of blocks) {
        if (block.type === "text") {
          process.stdout.write(block.text);
        } else if (block.type === "tool_use") {
          console.log(`\n[tool: ${block.name}]`);
        }
      }
    }
  } else if (msg.role === "user" && Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const label = block.is_error ? "FAIL" : "OK";
        const preview = block.content.slice(0, 100);
        console.log(
          `[${block.tool_use_id} ${label}: ${preview}${block.content.length > 100 ? "..." : ""}]`,
        );
      }
    }
  }
}

async function runGenericHarnessLoop(agent: Agent): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    const line = await rl.question("> ");
    if (line === "") continue;
    try {
      for await (const event of agent.run(line)) {
        renderEvent(event);
      }
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
    }
    console.log();
  }
}

async function runLegacyRepl(): Promise<void> {
  if (!TAVILY_API_KEY) {
    console.error("TAVILY_API_KEY environment variable required");
    process.exit(1);
  }

  const store = new Map<string, string>();
  const tools = [
    webFetchTool,
    createWebSearchTool(TAVILY_API_KEY),
    createMemorySaveTool(store),
    createMemoryRecallTool(store),
    readTool,
    writeTool,
  ];

  const messages: Message[] = [];
  if (systemArg) {
    messages.push({ role: "system", content: systemArg });
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`Model: ${modelArg}  Max steps: ${maxStepsArg}`);
  if (systemArg) console.log(`System: ${systemArg}`);
  console.log("Type your message (Ctrl+C to exit)\n");

  while (true) {
    const line = await rl.question("> ");
    if (line === "") continue;

    messages.push({ role: "user", content: line });

    try {
      for await (const msg of run(model, tools, messages, { maxSteps: Number(maxStepsArg) })) {
        const blocks = typeof msg.content === "string" ? msg.content : msg.content;

        if (msg.role === "assistant") {
          if (typeof blocks === "string") {
            process.stdout.write(blocks);
          } else {
            for (const block of blocks) {
              if (block.type === "text") {
                process.stdout.write(block.text);
              } else if (block.type === "tool_use") {
                console.log(`\n[tool: ${block.name}]`);
              }
            }
          }
        } else if (msg.role === "user" && Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block.type === "tool_result") {
              const label = block.is_error ? "FAIL" : "OK";
              const preview = block.content.slice(0, 100);
              console.log(
                `[${block.tool_use_id} ${label}: ${preview}${block.content.length > 100 ? "..." : ""}]`,
              );
            }
          }
        }
      }
      console.log();
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
    }
  }
}

// --- Main ---

if (workspaceArg) {
  // Generic harness mode
  const { createGenericAgent } = await import("@my-agent-team/harness");
  const agent = await createGenericAgent({
    workspace: path.resolve(workspaceArg),
    model,
  });

  console.log(`Workspace: ${workspaceArg}  Model: ${modelArg}`);
  await runGenericHarnessLoop(agent);
} else {
  // Legacy REPL (M2 behavior, zero changes)
  await runLegacyRepl();
}
