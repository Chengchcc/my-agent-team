import type { Tool } from "@my-agent-team/core";

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a bash shell command. Returns exit code, stdout, and stderr. Default timeout 30s, max 600s.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 30000, max 600000)",
      },
    },
    required: ["command"],
  },
  async execute(input) {
    const { command, timeout = 30_000 } = input as {
      command: string;
      timeout?: number;
    };
    const clamped = Math.min(Math.max(timeout, 1), 600_000);

    const proc = Bun.spawn(["bash", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => proc.kill(), clamped);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);

      const body = `exit=${exitCode}\n--- stdout ---\n${stdout}--- stderr ---\n${stderr}`;
      if (exitCode === 0) {
        return { content: body };
      }
      return { content: body, isError: true };
    } finally {
      clearTimeout(timer);
    }
  },
};
