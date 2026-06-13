import { describe, expect, test } from "bun:test";
import { isBotMentioned, parseEvent } from "./event-parser.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixtureDir = join(import.meta.dir, "..", "fixtures");

function loadFixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf-8").trim();
}

describe("parseEvent", () => {
  test("parses p2p message", () => {
    const line = loadFixture("message-p2p.json");
    const event = parseEvent(line);
    expect(event).not.toBeNull();
    expect(event!.chat_type).toBe("p2p");
    expect(event!.chat_id).toBe("oc_p2p001");
    expect(event!.sender_id).toBe("ou_user001");
    expect(event!.content).toContain("测试");
  });

  test("parses group @bot message", () => {
    const line = loadFixture("message-group-mention-bot.json");
    const event = parseEvent(line);
    expect(event).not.toBeNull();
    expect(event!.chat_type).toBe("group");
    expect(isBotMentioned(event!.content, "小开")).toBe(true);
  });

  test("parses group no-mention message", () => {
    const line = loadFixture("message-group-no-mention.json");
    const event = parseEvent(line);
    expect(event).not.toBeNull();
    expect(isBotMentioned(event!.content, "小开")).toBe(false);
  });

  test("parses interactive card (raw JSON content)", () => {
    const line = loadFixture("message-interactive-card.json");
    const event = parseEvent(line);
    expect(event).not.toBeNull();
    expect(event!.message_type).toBe("interactive");
    // Cards should parse without error — MVP does not parse card content
  });

  test("returns null for invalid JSON", () => {
    expect(parseEvent("not json")).toBeNull();
  });

  test("returns null for missing required fields", () => {
    expect(parseEvent('{"foo":"bar"}')).toBeNull();
  });

  test("returns null for empty event_id string", () => {
    expect(
      parseEvent(
        '{"event_id":"","message_id":"om_1","chat_id":"oc_1","sender_id":"ou_1","chat_type":"p2p","content":"hi"}',
      ),
    ).toBeNull();
  });

  test("returns null for missing message_id", () => {
    expect(
      parseEvent(
        '{"event_id":"evt_1","chat_id":"oc_1","sender_id":"ou_1","chat_type":"p2p","content":"hi"}',
      ),
    ).toBeNull();
  });

  test("returns null for invalid chat_type", () => {
    expect(
      parseEvent(
        '{"event_id":"evt_1","message_id":"om_1","chat_id":"oc_1","sender_id":"ou_1","chat_type":"channel","content":"hi"}',
      ),
    ).toBeNull();
  });

  test("returns null when content is non-string", () => {
    expect(
      parseEvent(
        '{"event_id":"evt_1","message_id":"om_1","chat_id":"oc_1","sender_id":"ou_1","chat_type":"p2p","content":123}',
      ),
    ).toBeNull();
  });

  test("returns null when sender_id is empty string", () => {
    expect(
      parseEvent(
        '{"event_id":"evt_1","message_id":"om_1","chat_id":"oc_1","sender_id":"","chat_type":"p2p","content":"hi"}',
      ),
    ).toBeNull();
  });
});
