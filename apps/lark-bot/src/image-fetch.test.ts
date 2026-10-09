import { describe, expect, test } from "bun:test";
import { larkImageKeysOf, stripImageMarkers } from "./image-fetch.js";

describe("larkImageKeysOf", () => {
  test("reads the platform's JSON shape", () => {
    expect(larkImageKeysOf('{"image_key":"img_v2_abc123"}')).toEqual(["img_v2_abc123"]);
  });

  test("accepts a bare key (lark-cli may pre-render)", () => {
    expect(larkImageKeysOf("img_v2_abc123")).toEqual(["img_v2_abc123"]);

    // The live shape (2026-10-09): a captioned post message renders the image
    // inline; the scan reads the key out of the markdown, caption and all.
    expect(larkImageKeysOf("![Image](img_v3_0216a_deadbeef)\n理解这个图片")).toEqual([
      "img_v3_0216a_deadbeef",
    ]);
  });

  test("anything else is no image — never a run on garbage", () => {
    expect(larkImageKeysOf("hello")).toEqual([]);
    expect(larkImageKeysOf('{"text":"hi"}')).toEqual([]);
    expect(larkImageKeysOf("")).toEqual([]);

    // Deduped, in order: a picture flood is not a conversation.
    expect(larkImageKeysOf("![a](img_v1_a) and ![b](img_v1_b) and again (img_v1_a)")).toEqual([
      "img_v1_a",
      "img_v1_b",
    ]);
  });
});

describe("stripImageMarkers", () => {
  test("the caption survives, the dead link does not", () => {
    expect(stripImageMarkers("![Image](img_v3_0216a_x)\n理解这个图片")).toBe("理解这个图片");
    expect(stripImageMarkers("plain text")).toBe("plain text");
  });
});
