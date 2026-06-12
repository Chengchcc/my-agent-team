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
import { hasHardFlag, parseFlag, resolveRmAgentId } from "./args.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY environment variable required");
  process.exit(1);
}

const args = process.argv.slice(2);
const modelArg = parseFlag(args, "model") ?? "claude-opus-4-7";
const maxStepsArg = parseFlag(args, "max-steps") ?? "32";
const systemArg = parseFlag(args, "system");
const workspaceArg = parseFlag(args, "workspace");
const backendUrl = parseFlag(args, "backend");
const conversationId = parseFlag(args, "conversation");
const rmAgentId = resolveRmAgentId(args);
const hardFlag = hasHardFlag(args);

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

// ─── M9: Remote mode (--backend <url>) ─────────────────────────────

async function runRemoteMode(baseUrl: string): Promise<void> {
  const threadId = crypto.randomUUID();
  let lastEventId = 0;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Backend: ${baseUrl}  Model: ${modelArg}`);

  while (true) {
    const line = await rl.question("> ");
    if (line === "") continue;

    try {
      // POST /api/threads/:id/runs → 202 { runId }
      const postRes = await fetch(`${baseUrl}/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: line }),
      });
      if (!postRes.ok) {
        const err = await postRes.json().catch(() => ({}));
        console.error(`Error: ${postRes.status} ${JSON.stringify(err)}`);
        continue;
      }
      const { runId } = (await postRes.json()) as { runId: string };

      // GET /api/runs/:id/events (SSE, with Last-Event-ID reconnect)
      const eventsRes = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
        headers: lastEventId > 0 ? { "Last-Event-ID": String(lastEventId) } : {},
      });

      if (!eventsRes.ok || !eventsRes.body) {
        console.error(`Error: events stream failed (${eventsRes.status})`);
        continue;
      }

      const reader = eventsRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const rawLine of lines) {
          const sseLine = rawLine.trim();
          if (!sseLine) continue;

          if (sseLine.startsWith("id: ")) {
            lastEventId = parseInt(sseLine.slice(4), 10) || lastEventId;
          } else if (sseLine.startsWith("data: ")) {
            try {
              const ev = JSON.parse(sseLine.slice(6));
              if (ev.type === "message") {
                renderEvent({ type: "message", payload: ev.message ?? ev.payload });
              } else if (ev.type !== "done") {
                console.log(`\n[${ev.type}]`);
              }
            } catch {
              // skip unparseable lines
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

// ─── M10: Conversation mode (--backend <url> --conversation <id>) ─────────

async function runConversationMode(baseUrl: string, convId: string): Promise<void> {
  // Parse @mention syntax: @<memberId> <text>
  function parseMention(input: string): { addressedTo: string[]; text: string } {
    const match = input.match(/^@(\S+)\s+(.*)/);
    if (match) {
      return { addressedTo: [match[1]!], text: match[2]! };
    }
    return { addressedTo: [], text: input };
  }

  let lastEventId = 0;
  const senderMemberId = `human-cli`;
  let conversationCreated = false;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Backend: ${baseUrl}  Conversation: ${convId}`);

  // Create conversation if needed
  try {
    const createRes = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: convId,
        members: [
          { kind: "human", memberId: senderMemberId, userRef: "cli-user", displayName: "You" },
        ],
      }),
    });
    if (createRes.ok) {
      conversationCreated = true;
      const body = (await createRes.json()) as { conversationId: string; members: unknown[] };
      console.log(`Conversation created: ${body.conversationId} (${body.members.length} members)`);
    }
  } catch (err) {
    console.error(
      "Failed to create conversation:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  if (!conversationCreated) {
    // Conversation already exists — fetch member list
    try {
      const membersRes = await fetch(`${baseUrl}/api/conversations/${convId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "human", memberId: senderMemberId, userRef: "cli-user" }),
      });
      // Ignore errors — might already exist
      const members = await membersRes.json().catch(() => ({}));
      if ((members as { members?: unknown[] }).members) {
        console.log(
          `Members online: ${(members as { members: Array<{ displayName?: string }> }).members.map((m) => m.displayName ?? "?").join(", ")}`,
        );
      }
    } catch {
      /* best-effort */
    }
  }

  console.log("Type @<member> <text> to address an agent, or just text to chat\n");

  while (true) {
    const line = await rl.question("> ");
    if (line === "") continue;

    const { addressedTo, text } = parseMention(line);

    try {
      // POST /api/conversations/:id/messages
      const postRes = await fetch(`${baseUrl}/api/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderMemberId,
          addressedTo,
          content: { text },
        }),
      });
      if (!postRes.ok) {
        const err = await postRes.json().catch(() => ({}));
        console.error(`Error: ${postRes.status} ${JSON.stringify(err)}`);
        continue;
      }
      const { seq, triggeredRuns } = (await postRes.json()) as {
        seq: number;
        triggeredRuns: Array<{ agentMemberId: string; runId: string }>;
      };

      if (addressedTo.length > 0 && triggeredRuns.length > 0) {
        const runId = triggeredRuns[0]?.runId;
        console.log(`[@${addressedTo[0]}] run started: ${runId}`);

        // Subscribe to conversation events
        const eventsRes = await fetch(`${baseUrl}/api/conversations/${convId}/events`, {
          headers: lastEventId > 0 ? { "Last-Event-ID": String(lastEventId) } : {},
        });

        if (eventsRes.ok && eventsRes.body) {
          const reader = eventsRes.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });

            const lines = buf.split("\n");
            buf = lines.pop() ?? "";

            for (const rawLine of lines) {
              const sseLine = rawLine.trim();
              if (!sseLine) continue;

              if (sseLine.startsWith("id: ")) {
                lastEventId = parseInt(sseLine.slice(4), 10) || lastEventId;
              } else if (sseLine.startsWith("data: ")) {
                try {
                  const data = JSON.parse(sseLine.slice(6));
                  if (data.kind === "message") {
                    const content =
                      typeof data.content === "string"
                        ? (() => {
                            try {
                              return JSON.parse(data.content);
                            } catch {
                              return data.content;
                            }
                          })()
                        : data.content;
                    const text =
                      typeof content === "object" && content?.text ? content.text : String(content);
                    if (data.senderMemberId !== senderMemberId) {
                      process.stdout.write(`${text}\n`);
                    }
                  }
                } catch {
                  /* skip */
                }
              }
            }
          }
        }
      } else {
        console.log(`[seq:${seq}] (no agent triggered)`);
      }
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
    }
    console.log();
  }
}

// ─── M11: agent rm ──────────────────────────────────────────────

if (rmAgentId) {
  if (!backendUrl) {
    console.error("Error: --backend=<url> is required for --rm");
    process.exit(1);
  }

  const method = hardFlag ? "hard delete (irreversible!)" : "archive";
  console.log(`This will ${method} agent '${rmAgentId}'.`);
  if (hardFlag) {
    console.log("Workspace and all history will be permanently deleted.");
  }
  process.stdout.write("Continue? (y/N): ");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("");
  rl.close();

  if (answer.toLowerCase() !== "y") {
    console.log("Cancelled.");
    process.exit(0);
  }

  try {
    const url = hardFlag
      ? `${backendUrl}/api/agents/${rmAgentId}?hard=true`
      : `${backendUrl}/api/agents/${rmAgentId}`;
    const res = await fetch(url, { method: "DELETE" });
    if (res.ok) {
      console.log(`Agent '${rmAgentId}' ${hardFlag ? "permanently deleted" : "archived"}.`);
    } else {
      const body = await res.json().catch(() => ({}));
      console.error(`Error: ${res.status} ${(body as { error?: string }).error ?? ""}`);
      process.exit(1);
    }
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  process.exit(0);
}

// --- Main ---

if (backendUrl && conversationId) {
  // M10: Conversation mode — POST /messages + GET /conversations/:id/events
  await runConversationMode(backendUrl, conversationId);
} else if (backendUrl) {
  // M9: Remote mode — POST 202 + GET /events SSE
  await runRemoteMode(backendUrl);
} else if (workspaceArg) {
  // Generic harness mode (local)
  const { createGenericAgent } = await import("@my-agent-team/harness");
  const { makeDevWorkspaceHandle } = await import("@my-agent-team/workspace-fs");
  const ws = makeDevWorkspaceHandle(path.resolve(workspaceArg));
  const agent = await createGenericAgent({ workspace: ws, model });

  console.log(`Workspace: ${workspaceArg}  Model: ${modelArg}`);
  await runGenericHarnessLoop(agent);
} else {
  // Legacy REPL (M2 behavior, zero changes)
  await runLegacyRepl();
}
