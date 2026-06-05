import { describe, expect, test } from "bun:test";
import { readTool } from "./read.js";

describe("readTool", () => {
  test("returns file content when file exists", async () => {
    const tmpPath = `/tmp/test-read-${Date.now()}.txt`;
    await Bun.write(tmpPath, "hello from read");

    const result = await readTool.execute({ path: tmpPath });

    expect(result).toEqual({ content: "hello from read" });
  });

  test("returns isError when file does not exist", async () => {
    const result = await readTool.execute({ path: "/tmp/nonexistent-m2-read.txt" });

    expect(result.isError).toBe(true);
    expect(result.content).toInclude("File not found");
  });
});
