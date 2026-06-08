import { describe, test, expect } from "bun:test";

interface ParsedSSEField {
  event?: string;
  data?: string;
  id?: string;
}

function parseSSELine(line: string): { key: string; value: string } | null {
  if (line === "" || line.startsWith(":")) return null;
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const key = line.slice(0, colon);
  let value = line.slice(colon + 1);
  if (value.startsWith(" ")) value = value.slice(1);
  return { key, value };
}

function parseSSEEvent(lines: string[]): ParsedSSEField {
  const event: ParsedSSEField = {};
  for (const line of lines) {
    const parsed = parseSSELine(line);
    if (!parsed) continue;
    if (parsed.key === "event") event.event = parsed.value;
    if (parsed.key === "data") event.data = parsed.value;
    if (parsed.key === "id") event.id = parsed.value;
  }
  return event;
}

function splitSSEStream(raw: string): string[][] {
  return raw
    .split("\n\n")
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => chunk.split("\n"));
}

describe("SSE parse", () => {
  test("parses event, data, and id lines", () => {
    expect(parseSSELine("event: message")).toEqual({
      key: "event",
      value: "message",
    });
    expect(parseSSELine('data: {"type":"message"}')).toEqual({
      key: "data",
      value: '{"type":"message"}',
    });
    expect(parseSSELine("id: 42")).toEqual({ key: "id", value: "42" });
  });

  test("ignores comments and empty lines", () => {
    expect(parseSSELine("")).toBeNull();
    expect(parseSSELine(": heartbeat")).toBeNull();
  });

  test("parses complete SSE event from lines", () => {
    const lines = [
      "id: 1",
      "event: message",
      'data: {"type":"message","payload":{"role":"assistant","content":"hi"}}',
    ];
    const event = parseSSEEvent(lines);
    expect(event.id).toBe("1");
    expect(event.event).toBe("message");
    expect(event.data).toBe(
      '{"type":"message","payload":{"role":"assistant","content":"hi"}}',
    );
  });

  test("deduplicates events by seq", () => {
    const raw = [
      'id: 1\nevent: message\ndata: {"type":"message","payload":{"role":"assistant","content":"hi"}}',
      'id: 2\nevent: message\ndata: {"type":"message","payload":{"role":"assistant","content":"there"}}',
      'id: 1\nevent: message\ndata: {"type":"message","payload":{"role":"assistant","content":"hi"}}',
    ].join("\n\n");

    const chunks = splitSSEStream(raw);
    const seen = new Set<number>();
    const results: ParsedSSEField[] = [];

    for (const lines of chunks) {
      const event = parseSSEEvent(lines);
      const seq = event.id ? parseInt(event.id, 10) : 0;
      if (!seen.has(seq)) {
        seen.add(seq);
        results.push(event);
      }
    }

    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe("1");
    expect(results[1]!.id).toBe("2");
  });

  test("parses done and error event types", () => {
    const doneLines = ["event: done", "data: {}"];
    const errorLines = ["event: error", 'data: {"error":"something went wrong"}'];

    expect(parseSSEEvent(doneLines)).toEqual({
      event: "done",
      data: "{}",
    });
    expect(parseSSEEvent(errorLines)).toEqual({
      event: "error",
      data: '{"error":"something went wrong"}',
    });
  });
});
