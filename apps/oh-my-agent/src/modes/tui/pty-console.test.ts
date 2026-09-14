import { describe, expect, test } from "bun:test";
import type { TUI } from "@chengchenccc/tui";
import { runBashPtyConsole } from "./pty-console.js";

/** The pty console hands the terminal to a child process; on exit the app
 *  must re-assert the modes it owns, or the user's next keystroke decodes
 *  against a child-modified terminal (a real session leaked raw CSI-u tails
 *  into the editor after an interactive command had taken the tty). */
describe("pty console terminal handback", () => {
  test("re-asserts the terminal state on teardown", async () => {
    const calls: string[] = [];
    const stub = {
      terminal: {
        columns: 100,
        rows: 30,
        reassertTerminalState: () => calls.push("reassert"),
      },
      showOverlay: () => ({ hide: () => calls.push("hide") }),
      setFocus: () => {},
      requestRender: () => {},
    } as unknown as TUI;
    const result = await runBashPtyConsole(stub, { command: "echo hi", cwd: "/tmp", env: {} });
    expect(result.exitCode).toBe(0);
    expect(calls).toContain("reassert");
  }, 20_000);
});
