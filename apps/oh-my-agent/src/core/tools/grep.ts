import type { Tool } from "@chengchenccc/message";
import { readStringField } from "./presentation.js";
import { WorkspaceSandbox } from "./workspace-sandbox.js";

const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining why this search is being performed.",
};

export function createGrepTool(opts: { workspaceRoot: string }): Tool {
  const sandbox = new WorkspaceSandbox(opts.workspaceRoot);

  return {
    name: "grep",
    // The pattern is what the user asked for; a peer sees "searching X in Y".
    describeStart: (input) => {
      const pattern = readStringField(input, "pattern");
      if (!pattern) return { title: "搜索代码", icon: "search", visibility: "compact" };
      const path = readStringField(input, "path");
      return {
        title: "搜索代码",
        detail: path ? `${pattern}（${path}）` : pattern,
        icon: "search",
        visibility: "compact",
      };
    },
    describeResult: (_input, result) => {
      // The raw matches stay inside oma; the count is what a card needs.
      const record = typeof result === "object" && result !== null ? result : null;
      const text = record !== null && "content" in record ? record.content : undefined;
      if (typeof text !== "string" || text.length === 0) return undefined;
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      const files = new Set(
        lines.map((l) => l.split(":")[0]).filter((p) => p && !p.startsWith("…")),
      );
      return {
        title: "搜索代码",
        resultSummary: `命中 ${lines.length} 处，涉及 ${files.size} 个文件`,
        icon: "search",
        visibility: "compact",
      };
    },
    description:
      "Search files using ripgrep. Returns matching lines with line numbers. Requires `rg`.",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        pattern: { type: "string", description: "The regex pattern to search for" },
        path: {
          type: "string",
          description: "File or directory to search in (relative to workspace root)",
        },
        glob: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts')" },
      },
      required: ["pattern"],
    },
    async execute(input) {
      const {
        pattern,
        path: searchPath,
        glob,
      } = input as {
        pattern: string;
        path?: string;
        glob?: string;
      };

      let validatedPath = opts.workspaceRoot;
      if (searchPath) {
        try {
          validatedPath = sandbox.validate(searchPath);
        } catch {
          return {
            content: `Error: path escapes workspace root: ${String(searchPath)}`,
            isError: true,
          };
        }
      }

      const args = ["rg", "-n", "--color=never"];
      if (glob) args.push("--glob", glob);
      // "-e" + "--": the model-controlled pattern must never be parsed as an
      // rg option (e.g. --pre=<cmd> executes a shell per file — an ungated
      // RCE); the path likewise must not be option-consumed.
      args.push("-e", pattern, "--", validatedPath);

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      } catch {
        return { content: "grep failed: ripgrep not found", isError: true };
      }

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);

      if (exitCode === 1) return { content: "" };
      if (exitCode >= 2)
        return { content: `grep failed (exit=${exitCode}): ${stderr}`, isError: true };
      return { content: stdout };
    },
  };
}
