import { describe, expect, test } from "bun:test";
import { larkImageKeyOf } from "./image-fetch.js";

describe("larkImageKeyOf", () => {
  test("reads the platform's JSON shape", () => {
    expect(larkImageKeyOf('{"image_key":"img_v2_abc123"}')).toBe("img_v2_abc123");
  });

  test("accepts a bare key (lark-cli may pre-render)", () => {
    expect(larkImageKeyOf("img_v2_abc123")).toBe("img_v2_abc123");
    expect(larkImageKeyOf("  img_v2_x  ")).toBe("img_v2_x");
  });

  test("anything else is no image — never a run on garbage", () => {
    expect(larkImageKeyOf("hello")).toBeNull();
    expect(larkImageKeyOf('{"text":"hi"}')).toBeNull();
    expect(larkImageKeyOf("")).toBeNull();
  });
});
