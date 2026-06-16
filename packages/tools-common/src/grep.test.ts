import { beforeAll, describe, expect, test } from "bun:test";
import { grepTool } from "./grep.js";

const hasRg = (() => {
  try {
    Bun.spawnSync({ cmd: ["rg", "--version"], stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("grepTool", () => {
  beforeAll(() => {
    if (!hasRg) {
      console.warn("SKIP: rg (ripgrep) not installed — skipping grepTool tests");
    }
  });

  test("returns stdout when matches found", async () => {
    if (!hasRg) return;
    // Use a temp dir with known content
    const tmpDir = `/tmp/test-grep-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();
    await Bun.write(`${tmpDir}/a.txt`, "hello world\nhello again\n goodbye");

    const result = await grepTool.execute({
      pattern: "hello",
      path: tmpDir,
    });

    expect(result.content).toInclude("hello");
    expect(result.isError).toBeUndefined();
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("returns empty string on no matches (rg exit code 1)", async () => {
    if (!hasRg) return;
    const tmpDir = `/tmp/test-grep-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();
    await Bun.write(`${tmpDir}/a.txt`, "hello world");

    const result = await grepTool.execute({
      pattern: "nonexistentZZZZ",
      path: tmpDir,
    });

    expect(result.content).toBe("");
    expect(result.isError).toBeUndefined();
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("glob filtering works", async () => {
    if (!hasRg) return;
    const tmpDir = `/tmp/test-grep-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();
    await Bun.write(`${tmpDir}/a.ts`, "hello");
    await Bun.write(`${tmpDir}/b.txt`, "hello");

    const result = await grepTool.execute({
      pattern: "hello",
      path: tmpDir,
      glob: "*.ts",
    });

    // Should only find in a.ts
    expect(result.content).toInclude("a.ts");
    expect(result.content).not.toInclude("b.txt");
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });
});
