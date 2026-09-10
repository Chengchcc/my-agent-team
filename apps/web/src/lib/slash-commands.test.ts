import { describe, expect, test } from "bun:test";
import { findCommand, parseArgs, slashCommands } from "./slash-commands";

function makeCtx() {
  const toasts: Array<{ msg: string; type?: string }> = [];
  return {
    ctx: {
      conversationId: "c1",
      args: "",
      currentRunId: null,
      router: { push: () => {} },
      toast: (msg: string, type?: "success" | "error" | "info") => {
        toasts.push({ msg, type });
      },
    },
    toasts,
  };
}

describe("slash command dispatch", () => {
  test("findCommand matches case-insensitively and ignores extra words", () => {
    expect(findCommand("/clear")?.command).toBe("/clear");
    expect(findCommand("/CLEAR")?.command).toBe("/clear");
    expect(findCommand("  /compact  ")?.command).toBe("/compact");
    expect(findCommand("/title hello world")?.command).toBe("/title");
  });

  test("findCommand returns undefined for non-commands", () => {
    expect(findCommand("plain message")).toBeUndefined();
    expect(findCommand("/nope")).toBeUndefined();
    expect(findCommand("")).toBeUndefined();
  });

  test("parseArgs keeps everything after the command word", () => {
    expect(parseArgs("/title   My   Title ")).toBe("My Title");
    expect(parseArgs("/clear")).toBe("");
    expect(parseArgs("/stop")).toBe("");
  });

  test("registry invariants: unique, prefixed, documented", () => {
    const commands = slashCommands.map((c) => c.command);
    expect(new Set(commands).size).toBe(commands.length);
    for (const c of slashCommands) {
      expect(c.command.startsWith("/")).toBe(true);
      expect(c.description.length).toBeGreaterThan(0);
      expect(typeof c.execute).toBe("function");
    }
  });

  test("/title with no args shows usage and does not reach the API", async () => {
    const { ctx, toasts } = makeCtx();
    const result = await findCommand("/title")!.execute({ ...ctx, args: "   " });
    expect(result).toEqual({ handled: true });
    expect(toasts).toEqual([{ msg: "Usage: /title <title>", type: "error" }]);
  });

  test("/stop without a running agent is handled locally with an error toast", async () => {
    const { ctx, toasts } = makeCtx();
    const result = await findCommand("/stop")!.execute(ctx);
    expect(result).toEqual({ handled: true });
    expect(toasts).toEqual([{ msg: "No agent is currently running", type: "error" }]);
  });
});
