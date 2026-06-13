import type { Tool } from "@my-agent-team/core";
import type { AgentFsLike } from "./agent-fs-like.js";

// ─── AFS-native read tool ───

export function createReadToolForWorkspace(ws: AgentFsLike): Tool {
  return {
    name: "read",
    description:
      "Read a file and return its content as text. Uses logical paths (e.g. /SOUL.md, /memory/today.md).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Logical path to the file to read" },
      },
      required: ["path"],
    },
    async execute(input) {
      const { path } = input as { path: string };
      const content = await ws.read(path);
      if (content === null) return { content: `File not found: ${path}`, isError: true };
      return { content };
    },
  };
}

// ─── AFS-native write tool ───

export function createWriteToolForWorkspace(ws: AgentFsLike): Tool {
  return {
    name: "write",
    description: "Write content to a file. Creates parent directories. Uses logical paths.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Logical path to write to" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
    async execute(input) {
      const { path, content } = input as { path: string; content: string };
      await ws.write(path, content);
      return { content: `Wrote ${content.length} bytes to ${path}` };
    },
  };
}

// ─── AFS-native edit tool ───

export function createEditToolForWorkspace(ws: AgentFsLike): Tool {
  return {
    name: "edit",
    description: "Edit a file by replacing old_string with new_string. Uses logical paths.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Logical path to the file to edit" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute(input) {
      const {
        path: p,
        old_string,
        new_string,
      } = input as { path: string; old_string: string; new_string: string };
      const content = await ws.read(p);
      if (content === null) return { content: `File not found: ${p}`, isError: true };
      if (!content.includes(old_string))
        return { content: `old_string not found in ${p}`, isError: true };
      const replacement = content.replace(old_string, new_string);
      await ws.write(p, replacement);
      return { content: `Edited ${p}: replaced 1 occurrence` };
    },
  };
}
