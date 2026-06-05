import { describe, expect, test } from "bun:test";
import { writeTool } from "./write.js";

describe("writeTool", () => {
  test("writes content to a file and verifies it", async () => {
    const tmpPath = `/tmp/test-write-${Date.now()}.txt`;

    const result = await writeTool.execute({ path: tmpPath, content: "hello from write" });

    expect(result).toEqual({ content: `Wrote: ${tmpPath}` });
    expect(await Bun.file(tmpPath).text()).toBe("hello from write");
  });
});
