import { describe, expect, test } from "bun:test";
import { KITTY_KEYBOARD_SET_FLAGS, VirtualTerminal } from "./index.ts";

/** Terminal re-assert contract: after a child process (pty console, shell
 *  escape, an interactive command) hands the terminal back, the app owns
 *  the modes again. A real session leaked raw CSI-u tails into the editor
 *  because the child had changed them. */
describe("terminal re-assert", () => {
  test("the kitty re-assert uses the SET form, never a second push", () => {
    expect(KITTY_KEYBOARD_SET_FLAGS).toBe("\u001b[=7u");
    // Push form (CSI > flags u) grows the terminal's flag stack per call.
    expect(KITTY_KEYBOARD_SET_FLAGS.includes(">")).toBe(false);
  });

  test("VirtualTerminal satisfies the contract as a no-op", () => {
    const vt = new VirtualTerminal(80, 24);
    expect(typeof vt.reassertTerminalState).toBe("function");
    vt.reassertTerminalState();
  });
});
