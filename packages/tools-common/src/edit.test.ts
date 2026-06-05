import { describe, expect, test } from "bun:test";
import { editTool } from "./edit.js";

describe("editTool", () => {
  test("single match replaces successfully", async () => {
    const tmpPath = `/tmp/test-edit-${Date.now()}.txt`;
    await Bun.write(tmpPath, "line1\nold line\nline3");

    const result = await editTool.execute({
      path: tmpPath,
      oldString: "old line",
      newString: "new line",
    });

    expect(result).toEqual({ content: `Edited: ${tmpPath}` });
    expect(await Bun.file(tmpPath).text()).toBe("line1\nnew line\nline3");
  });

  test("zero matches returns isError", async () => {
    const tmpPath = `/tmp/test-edit-${Date.now()}.txt`;
    await Bun.write(tmpPath, "line1\nline2\nline3");

    const result = await editTool.execute({
      path: tmpPath,
      oldString: "nonexistent",
      newString: "new",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toInclude("oldString not found");
  });

  test("multiple matches returns isError", async () => {
    const tmpPath = `/tmp/test-edit-${Date.now()}.txt`;
    await Bun.write(tmpPath, "duplicate\nduplicate\nline3");

    const result = await editTool.execute({
      path: tmpPath,
      oldString: "duplicate",
      newString: "replaced",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toInclude("matches 2 times");
  });

  test("file not found returns isError", async () => {
    const result = await editTool.execute({
      path: "/tmp/nonexistent-edit-test.txt",
      oldString: "anything",
      newString: "new",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toInclude("File not found");
  });
});
