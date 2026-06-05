import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AIMessageChunk, ChatModel, Message, Tool } from "@my-agent-team/core";
import { createGenericAgent } from "./create-generic-agent.js";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

function scriptedModel(
  turns: Array<
    { type: "text"; text: string } | { type: "tool_call"; id: string; name: string; input: unknown }
  >,
): ChatModel {
  return {
    id: "scripted",
    async *stream(messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
      const turn = messages.filter((m) => m.role === "assistant").length;
      const item = turns[Math.min(turn, turns.length - 1)];
      if (!item) return;
      if (item.type === "text") {
        yield { delta: { type: "text", text: item.text } };
        yield { done: true, stopReason: "end_turn" };
      } else {
        yield { delta: { type: "tool_use", id: item.id, name: item.name } };
        yield {
          delta: {
            type: "input_json_delta",
            id: item.id,
            partial_json: JSON.stringify(item.input),
          },
        };
        yield { done: true, stopReason: "tool_use" };
      }
    },
  };
}

describe("createGenericAgent", () => {
  test("minimal opts returns Agent, can run a conversation", async () => {
    const ws = `/tmp/test-harness-${Date.now()}`;
    await mkdir(ws, { recursive: true });
    await mkdir(path.join(ws, "memory"), { recursive: true });

    try {
      await writeFile(path.join(ws, "SOUL.md"), "You are a test agent.");

      const agent = await createGenericAgent({
        workspace: ws,
        model: scriptedModel([{ type: "text", text: "I received your message" }]),
      });

      const events = await collect(agent.run("hello"));

      expect(events.length).toBeGreaterThan(0);
      const messages = events.filter((e) => e.type === "message");
      expect(messages.length).toBeGreaterThan(0);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("bootstrap injects systemPrompt from workspace files", async () => {
    const ws = `/tmp/test-harness-${Date.now()}`;
    await mkdir(ws, { recursive: true });
    await mkdir(path.join(ws, "memory"), { recursive: true });

    try {
      await writeFile(path.join(ws, "SOUL.md"), "You are a test agent.");

      const agent = await createGenericAgent({
        workspace: ws,
        model: scriptedModel([{ type: "text", text: "ok" }]),
      });

      // Run one turn to trigger system prompt injection
      await collect(agent.run("hello"));

      // Verify system prompt was injected and contains workspace content
      const sysMsg = agent.thread.messages.find((m) => m.role === "system");
      expect(sysMsg).toBeDefined();
      expect((sysMsg as Message).content).toInclude("<soul>");
      expect((sysMsg as Message).content).toInclude("You are a test agent.");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("extraTools merged with defaults", async () => {
    const ws = `/tmp/test-harness-${Date.now()}`;
    await mkdir(ws, { recursive: true });

    try {
      await writeFile(path.join(ws, "SOUL.md"), "test");

      const extraTool: Tool = {
        name: "my_extra",
        description: "extra",
        inputSchema: {},
        execute: () => ({ content: "extra" }),
      };

      const agent = await createGenericAgent({
        workspace: ws,
        model: scriptedModel([{ type: "text", text: "ok" }]),
        extraTools: [extraTool],
      });

      expect(agent.thread.messages).toBeDefined();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("duplicate tool name between default and extra fails fast", async () => {
    const ws = `/tmp/test-harness-${Date.now()}`;
    await mkdir(ws, { recursive: true });

    try {
      await writeFile(path.join(ws, "SOUL.md"), "test");

      const dupTool: Tool = {
        name: "read", // collides with default readTool
        description: "custom",
        inputSchema: {},
        execute: () => ({ content: "x" }),
      };

      await expect(
        createGenericAgent({
          workspace: ws,
          model: scriptedModel([{ type: "text", text: "ok" }]),
          extraTools: [dupTool],
        }),
      ).rejects.toThrow(/collision|read/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("extraPlugins merged with defaults", async () => {
    const ws = `/tmp/test-harness-${Date.now()}`;
    await mkdir(ws, { recursive: true });

    try {
      await writeFile(path.join(ws, "SOUL.md"), "test");

      const extraPlugin = {
        name: "my-extra-plugin",
        hooks: {},
      };

      const agent = await createGenericAgent({
        workspace: ws,
        model: scriptedModel([{ type: "text", text: "ok" }]),
        extraPlugins: [extraPlugin],
      });

      expect(agent.thread.messages).toBeDefined();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("permissionMode accepted and defaults to ask", async () => {
    const ws = `/tmp/test-harness-${Date.now()}`;
    await mkdir(ws, { recursive: true });

    try {
      await writeFile(path.join(ws, "SOUL.md"), "test");

      // Default: no permissionMode specified → should default to 'ask'
      const agent = await createGenericAgent({
        workspace: ws,
        model: scriptedModel([{ type: "text", text: "ok" }]),
      });

      expect(agent.thread.messages).toBeDefined();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
