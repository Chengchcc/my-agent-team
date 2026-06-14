import { describe, expect, test } from "bun:test";
import {
  parseRunStreamEvent,
  parseSseFrames,
} from "./run-delta-watcher.js";

describe("parseSseFrames", () => {
  test("parses a single event+data frame", () => {
    const frames = parseSseFrames(
      "event: text_delta\ndata: {\"blockIndex\":0,\"text\":\"hello\"}\n\n",
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]!.eventName).toBe("text_delta");
    expect(frames[0]!.dataText).toBe('{"blockIndex":0,"text":"hello"}');
  });

  test("handles event without data gracefully", () => {
    const frames = parseSseFrames("event: unknown\n\n");
    expect(frames).toHaveLength(0); // no data line → no frame emitted
  });

  test("handles multi-line data", () => {
    const frames = parseSseFrames(
      'data: line1\ndata: line2\n\n',
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]!.dataText).toBe("line1\nline2");
  });

  test("handles multiple frames in one chunk", () => {
    const frames = parseSseFrames(
      'event: text_delta\ndata: {"text":"a"}\n\nevent: text_delta\ndata: {"text":"b"}\n\n',
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]!.eventName).toBe("text_delta");
    expect(frames[1]!.eventName).toBe("text_delta");
  });

  test("handles empty input", () => {
    const frames = parseSseFrames("");
    expect(frames).toHaveLength(0);
  });

  test("handles chunk without complete frame", () => {
    const frames = parseSseFrames("event: text_delta\ndata: partial");
    expect(frames).toHaveLength(0); // no double newline
  });
});

describe("parseRunStreamEvent", () => {
  test("parses text_delta with blockIndex and text", () => {
    const ev = parseRunStreamEvent({
      eventName: "text_delta",
      data: { blockIndex: 0, text: "hello world" },
      runId: "run_1",
    });
    expect(ev.type).toBe("text_delta");
    if (ev.type === "text_delta") {
      expect(ev.text).toBe("hello world");
      expect(ev.blockIndex).toBe(0);
      expect(ev.runId).toBe("run_1");
    }
  });

  test("handles text_delta with missing blockIndex (defaults to 0)", () => {
    const ev = parseRunStreamEvent({
      eventName: "text_delta",
      data: { text: "hello" },
      runId: "run_1",
    });
    expect(ev.type).toBe("text_delta");
    if (ev.type === "text_delta") {
      expect(ev.text).toBe("hello");
      expect(ev.blockIndex).toBe(0);
    }
  });

  test("returns unknown for unrecognized event type", () => {
    const ev = parseRunStreamEvent({
      eventName: "tool_start",
      data: { id: "1", name: "bash" },
      runId: "run_1",
    });
    expect(ev.type).toBe("unknown");
    if (ev.type === "unknown") {
      expect(ev.rawType).toBe("tool_start");
    }
  });

  test("returns unknown for text_delta without text field", () => {
    const ev = parseRunStreamEvent({
      eventName: "text_delta",
      data: { blockIndex: 0 },
      runId: "run_1",
    });
    expect(ev.type).toBe("unknown");
  });

  test("returns unknown for non-object data", () => {
    const ev = parseRunStreamEvent({
      eventName: "text_delta",
      data: "raw string",
      runId: "run_1",
    });
    expect(ev.type).toBe("unknown");
  });

  test("returns unknown for null data", () => {
    const ev = parseRunStreamEvent({
      eventName: "text_delta",
      data: null,
      runId: "run_1",
    });
    expect(ev.type).toBe("unknown");
  });
});
