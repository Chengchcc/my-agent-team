import type { Tool } from "@chengchenccc/message";
import { childEnv } from "@chengchenccc/message";
import { deniedReadRefusal } from "./file-tools.js";
import { readStringField } from "./presentation.js";
import { WorkspaceSandbox } from "./workspace-sandbox.js";

const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining why this search is being performed.",
};

const MAX_GREP_BYTES = 128 * 1024;
const DEFAULT_HEAD_LIMIT = 500;
const MAX_HEAD_LIMIT = 2_000;
const MAX_CONTEXT_LINES = 10;
const GREP_ENV_DENY =
  /API_KEY|AUTH_TOKEN|ACCESS_KEY|PRIVATE_KEY|ENCRYPTION_KEY|_TOKEN$|_SECRET$|PASSWORD|PASSWD|CREDENTIAL|RIPGREP_CONFIG_PATH/i;

function safeGrepEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(childEnv(process.env)).filter(([k]) => !GREP_ENV_DENY.test(k)),
  );
}

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
      const lines = text.split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("... ["));
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
      "Search files using ripgrep. Returns matching lines with line numbers (capped at 500 lines / 128KB by default). Requires `rg`.",
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
        case_insensitive: {
          type: "boolean",
          description: "Case-insensitive search (-i). Defaults to false.",
        },
        files_only: {
          type: "boolean",
          description: "Only return matching file paths (-l). Defaults to false.",
        },
        context: {
          type: "number",
          description: "Number of context lines before and after each match (-C, 0-10).",
        },
        head_limit: {
          type: "number",
          description: "Maximum number of output lines to return (default 500, max 2000).",
        },
      },
      required: ["pattern"],
    },
    async execute(input, signal?: AbortSignal) {
      const {
        pattern,
        path: searchPath,
        glob,
        case_insensitive,
        files_only,
        context,
        head_limit,
      } = input as {
        pattern: string;
        path?: string;
        glob?: string;
        case_insensitive?: boolean;
        files_only?: boolean;
        context?: number;
        head_limit?: number;
      };

      if (signal?.aborted) {
        return { content: "Error: grep aborted", isError: true };
      }

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
      const denied = deniedReadRefusal(validatedPath);
      if (denied) {
        return { content: `Error: ${denied}`, isError: true };
      }

      const lineLimit =
        typeof head_limit === "number" && Number.isFinite(head_limit) && head_limit > 0
          ? Math.min(Math.floor(head_limit), MAX_HEAD_LIMIT)
          : DEFAULT_HEAD_LIMIT;

      const args = ["rg", "--no-config", "-n", "--color=never"];
      if (case_insensitive === true) args.push("-i");
      if (files_only === true) args.push("-l");
      if (
        typeof context === "number" &&
        Number.isFinite(context) &&
        context > 0 &&
        files_only !== true
      ) {
        args.push("-C", String(Math.min(Math.floor(context), MAX_CONTEXT_LINES)));
      }
      if (glob) args.push("--glob", glob);
      // "-e" + "--": the model-controlled pattern must never be parsed as an
      // rg option (e.g. --pre=<cmd> executes a shell per file — an ungated
      // RCE); the path likewise must not be option-consumed.
      args.push("-e", pattern, "--", validatedPath);

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(args, {
          stdout: "pipe",
          stderr: "pipe",
          env: safeGrepEnv(),
        });
      } catch {
        return { content: "grep failed: ripgrep not found", isError: true };
      }

      let aborted = false;
      const onAbort = (): void => {
        aborted = true;
        try {
          proc.kill();
        } catch {
          /* already exited */
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const stderrPromise = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        const lines: string[] = [];
        let pending = "";
        let totalBytes = 0;
        let truncatedReason: string | null = null;

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            const chunk = decoder.decode(value, { stream: true });
            const parts = (pending + chunk).split("\n");
            pending = parts.pop() ?? "";
            for (const line of parts) {
              if (lines.length >= lineLimit) {
                truncatedReason = `${lineLimit} lines`;
                break;
              }
              lines.push(line);
            }
            if (!truncatedReason && totalBytes > MAX_GREP_BYTES) {
              truncatedReason = `${MAX_GREP_BYTES} bytes`;
            }
            if (truncatedReason) {
              try {
                proc.kill();
              } catch {
                /* ignore */
              }
              await reader.cancel().catch(() => {});
              break;
            }
          }
          if (!truncatedReason) {
            const tail = pending + decoder.decode();
            if (tail.length > 0) {
              if (lines.length < lineLimit) lines.push(tail);
              else truncatedReason = `${lineLimit} lines`;
            }
          }
        } finally {
          reader.releaseLock();
        }

        const [stderr, exitCode] = await Promise.all([stderrPromise, proc.exited]);
        if (aborted) return { content: "Error: grep aborted", isError: true };
        if (truncatedReason) {
          return {
            content: `${lines.join("\n")}\n... [truncated at ${truncatedReason}; narrow path/glob or pass head_limit]`,
          };
        }
        if (exitCode === 1) return { content: "" };
        if (exitCode >= 2)
          return { content: `grep failed (exit=${exitCode}): ${stderr}`, isError: true };
        return { content: lines.length > 0 ? `${lines.join("\n")}\n` : "" };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
