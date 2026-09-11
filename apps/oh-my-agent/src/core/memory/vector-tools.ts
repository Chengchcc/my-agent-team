import type { PluginTool } from "../index.js";
import type { VectorMemory } from "./vector-memory.js";
import { recallMemories, retainMemory } from "./vector-recall.js";

/** Model-facing vector-memory tools: `recall` (hybrid retrieval over the
 *  workspace memory DB) and `retain` (explicit durable store). Mounted in
 *  read_write runs only (recall bumps recall_count — a write). */

export function createRecallTool(memory: VectorMemory): PluginTool {
  return {
    name: "recall",
    description:
      "Search long-term workspace memory (vector + keyword hybrid, ranked by " +
      "fusion). Use when the injected memory summary is truncated or when you " +
      "need lessons beyond its newest-40 window. Returns id/content/context/" +
      "score per hit.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for (zh/en both fine)." },
        top_k: { type: "number", description: "Max hits (default 8)." },
      },
      required: ["query"],
    },
    async execute(args: Record<string, unknown>) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { content: "Error: query is required", isError: true };
      const topK = typeof args.top_k === "number" && args.top_k > 0 ? Math.min(32, args.top_k) : 8;
      const hits = await recallMemories(memory.store, memory.provider, query, { topK });
      if (hits.length === 0) {
        return { content: "No matching memories. `retain` can store one." };
      }
      const degraded = memory.provider?.unavailableReason;
      const lines = hits.map(
        (h, i) =>
          `${i + 1}. [${h.id}] ${h.content}` +
          `${h.context ? ` (context: ${h.context})` : ""} — score ${h.score.toFixed(4)}` +
          ` [vec ${h.voiceScores.vec?.toFixed(3) ?? "-"} / fts ${h.voiceScores.fts !== undefined ? "hit" : "-"}]`,
      );
      return {
        content: degraded
          ? `${lines.join("\n")}\n(vector voice unavailable: ${degraded})`
          : lines.join("\n"),
      };
    },
  };
}

export function createRetainTool(memory: VectorMemory): PluginTool {
  return {
    name: "retain",
    description:
      "Store one durable fact in the searchable long-term memory DB (hybrid " +
      "vector + keyword recall). Prefer the `learn` tool for lessons (it also " +
      "writes learned.md); use retain for raw facts that need retrieval.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The durable fact (max 2000 chars)." },
        context: { type: "string", description: "Where it applies (file/module/scope)." },
        importance: { type: "number", description: "0..1, default 0.5." },
      },
      required: ["content"],
    },
    async execute(args: Record<string, unknown>) {
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) return { content: "Error: content is required", isError: true };
      const id = await retainMemory(memory.store, memory.provider, {
        content: content.slice(0, 2000),
        ...(typeof args.context === "string" && args.context.trim()
          ? { context: args.context.trim().slice(0, 400) }
          : {}),
        source: "retain",
        ...(typeof args.importance === "number"
          ? { importance: Math.min(1, Math.max(0, args.importance)) }
          : {}),
      });
      if (!id) return { content: "duplicate of an existing memory" };
      return { content: `stored ${id}`, id };
    },
  };
}
