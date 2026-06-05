import type { Tool } from "@my-agent-team/core";

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search files using ripgrep. Returns matching lines with line numbers. " +
    "Requires `rg` to be installed on the system.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regex pattern to search for" },
      path: {
        type: "string",
        description: "File or directory to search in (optional, defaults to cwd)",
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

    const args = ["rg", "-n", "--color=never"];
    if (glob) args.push("--glob", glob);
    args.push(pattern);
    if (searchPath) args.push(searchPath);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      return {
        content:
          "grep failed: ripgrep not found, install via brew install ripgrep / apt install ripgrep",
        isError: true,
      };
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);

    // rg exit codes: 0 = matches, 1 = no matches, 2+ = error
    if (exitCode === 1) return { content: "" };
    if (exitCode >= 2) {
      return {
        content:
          stderr ||
          "grep failed: ripgrep not found, install via brew install ripgrep / apt install ripgrep",
        isError: true,
      };
    }
    return { content: stdout };
  },
};
