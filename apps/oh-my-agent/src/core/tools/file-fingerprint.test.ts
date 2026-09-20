import { describe, expect, test } from "bun:test";
import { computeFileFingerprint, fingerprintFooter, parseFingerprint } from "./file-fingerprint.js";

/** The fingerprint is the whole point of the write gate, so its properties are
 *  pinned here rather than only through the tools that consume it. */
describe("file fingerprint", () => {
  test("is stable for the same content and changes with it", () => {
    expect(computeFileFingerprint("a\nb\n")).toBe(computeFileFingerprint("a\nb\n"));
    expect(computeFileFingerprint("a\nb\n")).not.toBe(computeFileFingerprint("a\nc\n"));
    // Whitespace counts: only line-ending transport is normalized away.
    expect(computeFileFingerprint("a b")).not.toBe(computeFileFingerprint("a  b"));
    expect(computeFileFingerprint("")).not.toBe(computeFileFingerprint("\n"));
  });

  /** A CRLF<->LF flip is transport, not an edit: git autocrlf, an editor on
   *  another platform, or format-on-save must not invalidate a fresh read. */
  test("normalizes line endings so a CRLF flip is not a content change", () => {
    expect(computeFileFingerprint("a\r\nb\r\n")).toBe(computeFileFingerprint("a\nb\n"));
    // …but a real change under either convention still differs.
    expect(computeFileFingerprint("a\r\nb\r\n")).not.toBe(computeFileFingerprint("a\nb\nc\n"));
  });

  test("the shape is a fixed-width hex token (so it is cheap to eyeball)", () => {
    expect(computeFileFingerprint("x")).toMatch(/^[0-9a-f]{12}$/);
  });

  test("the footer round-trips through parseFingerprint", () => {
    const fp = computeFileFingerprint("content");
    const out = `1\tcontent${fingerprintFooter(fp)}`;
    expect(parseFingerprint(out)).toBe(fp);
    // No footer (freshness off) is not a fingerprint, and content that merely
    // looks like one is not mistaken for it.
    expect(parseFingerprint("1\tcontent")).toBeUndefined();
    expect(parseFingerprint("[fingerprint deadbeef]")).toBeUndefined(); // 8 hex, not 12
  });
});
