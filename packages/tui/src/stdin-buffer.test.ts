import { describe, expect, test } from "bun:test";
import { StdinBuffer } from "./stdin-buffer.ts";

const wait = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

describe("StdinBuffer bare-ESC flush extension", () => {
  test("split CSI-u sequence merges: tail in the second window joins the ESC", async () => {
    const buf = new StdinBuffer({ timeout: 10 });
    const emitted: string[] = [];
    buf.on("data", (s) => emitted.push(s));
    // Event-loop-blocked split: ESC read lands, timer fires before the tail
    // read is processed, tail arrives inside the extended window.
    buf.process("\x1b");
    await wait(15);
    expect(emitted).toEqual([]); // NOT flushed as a lone Esc yet
    buf.process("[99;1:3u");
    await wait(40);
    expect(emitted).toEqual(["\x1b[99;1:3u"]);
  });

  test("a real lone Esc still flushes after the extended window", async () => {
    const buf = new StdinBuffer({ timeout: 10 });
    const emitted: string[] = [];
    buf.on("data", (s) => emitted.push(s));
    buf.process("\x1b");
    await wait(60);
    expect(emitted).toEqual(["\x1b"]);
  });

  test("whole CSI-u sequence in one chunk is emitted immediately", async () => {
    const buf = new StdinBuffer({ timeout: 10 });
    const emitted: string[] = [];
    buf.on("data", (s) => emitted.push(s));
    buf.process("\x1b[99;1:3u");
    await wait(30);
    expect(emitted).toEqual(["\x1b[99;1:3u"]);
  });
});
