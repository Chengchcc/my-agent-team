import { describe, expect, test } from "bun:test";
import { globTool } from "./glob.js";

describe("globTool", () => {
  test("matches files by pattern", async () => {
    const tmpDir = `/tmp/test-glob-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}/sub`.quiet();
    await Bun.write(`${tmpDir}/a.ts`, "");
    await Bun.write(`${tmpDir}/b.ts`, "");
    await Bun.write(`${tmpDir}/c.txt`, "");

    const result = await globTool.execute({
      pattern: "*.ts",
      cwd: tmpDir,
    });

    expect(result.content).toInclude("a.ts");
    expect(result.content).toInclude("b.ts");
    expect(result.content).not.toInclude("c.txt");
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("returns (no matches) when nothing matches", async () => {
    const tmpDir = `/tmp/test-glob-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();

    const result = await globTool.execute({
      pattern: "*.xyz",
      cwd: tmpDir,
    });

    expect(result.content).toBe("(no matches)");
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("cwd parameter works", async () => {
    const tmpDir = `/tmp/test-glob-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}/sub`.quiet();
    await Bun.write(`${tmpDir}/sub/x.ts`, "");
    await Bun.write(`${tmpDir}/y.ts`, "");

    const result = await globTool.execute({
      pattern: "*.ts",
      cwd: `${tmpDir}/sub`,
    });

    expect(result.content).toInclude("x.ts");
    expect(result.content).not.toInclude("y.ts");
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });
});
