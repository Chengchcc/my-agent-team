import { afterEach, describe, expect, test } from "bun:test";
import { setTextSizingEnabled, textSizingEnabled, textSizingSupported } from "./text-sizing.ts";
import { encodeTextSized, visibleWidth } from "./utils.ts";

const ESC = String.fromCharCode(27);

afterEach(() => setTextSizingEnabled(undefined));

/** OSC 66 (Kitty ≥0.33 / Ghostty) is the only way a terminal can render a
 *  heading larger than body text. An unsupported terminal swallows the whole
 *  sequence — payload included — so it must never be sent by accident. */
describe("OSC 66 text sizing", () => {
  test("an unsupported terminal keeps the capability off", () => {
    expect(textSizingSupported({ TERM: "xterm-256color" })).toBe(false);
    expect(textSizingSupported({ TERM: "screen" })).toBe(false);
    expect(textSizingSupported({})).toBe(false);
  });

  test("known implementations are detected from the environment", () => {
    expect(textSizingSupported({ TERM: "xterm-kitty" })).toBe(true);
    expect(textSizingSupported({ TERM_PROGRAM: "ghostty" })).toBe(true);
    expect(textSizingSupported({ KITTY_WINDOW_ID: "1" })).toBe(true);
    expect(textSizingSupported({ TERM: "xterm-256color", OMA_TEXT_SIZING: "1" })).toBe(true);
    expect(textSizingSupported({ TERM: "xterm-kitty", OMA_TEXT_SIZING: "0" })).toBe(false);
  });

  test("the runtime flag follows detection and can be forced", () => {
    setTextSizingEnabled(true);
    expect(textSizingEnabled()).toBe(true);
    setTextSizingEnabled(false);
    expect(textSizingEnabled()).toBe(false);
  });

  test("a sized span measures at its scale, not zero", () => {
    const sized = encodeTextSized("Report", 2);
    expect(sized.startsWith(`${ESC}]66;s=2;`)).toBe(true);
    expect(sized.endsWith(`${ESC}\\`)).toBe(true);
    // A zero-width reading would let the frame pad over the sized glyphs.
    expect(visibleWidth(sized)).toBe(12);
    expect(visibleWidth(sized)).toBe(visibleWidth(encodeTextSized("Report", 2)));
    // Unscaled text keeps its normal width.
    expect(visibleWidth("Report")).toBe(6);
    expect(encodeTextSized("Report", 1)).toBe("Report");
  });

  test("control bytes cannot break out of the payload", () => {
    const sized = encodeTextSized(`bad${ESC}[31mred`, 2);
    expect(sized.slice(0, -2)).not.toContain(`${ESC}[31m`);
  });
});
