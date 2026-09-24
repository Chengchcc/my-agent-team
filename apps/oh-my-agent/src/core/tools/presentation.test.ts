import { describe, expect, test } from "bun:test";
import { createBashTool } from "./bash.js";
import { createReadTool } from "./file-tools.js";
import { createGrepTool } from "./grep.js";
import { readStringField, safeToolSummary } from "./presentation.js";

/** The activity line is the only thing about a tool call that crosses the
 *  process boundary and reaches Web/Lark, so these invariants are the
 *  security boundary, not cosmetics. */
describe("safeToolSummary", () => {
  test("flattens to one line and strips ANSI escapes", () => {
    const summary = safeToolSummary("正在执行：\u001B[31mbun test\u001B[0m\nrm -rf /", "fallback");
    expect(summary).toBe("正在执行：bun test rm -rf /");
    expect(summary).not.toContain("\u001B");
  });

  test("truncates long text to 160 chars with an ellipsis", () => {
    const summary = safeToolSummary(`正在执行：${"x".repeat(400)}`, "fallback");
    expect(summary).toHaveLength(160);
    expect(summary.endsWith("…")).toBe(true);
  });

  test("redacts credentials in their common shapes", () => {
    expect(safeToolSummary("curl -H 'Authorization: Bearer abcdefghijklmnop1234'", "f")).toBe(
      "curl -H 'Authorization: [已隐藏]'",
    );
    expect(safeToolSummary("ghp_abcdefghijklmnopqrstuvwx01", "f")).toBe("[已隐藏]");
    expect(safeToolSummary("export API_KEY=supersecretvalue", "f")).toBe("export [已隐藏]");
    expect(safeToolSummary("git clone https://user:hunter2@example.com/repo", "f")).toBe(
      "git clone https:[已隐藏]example.com/repo",
    );
  });

  test("falls back when the text is absent, empty, or only control characters", () => {
    expect(safeToolSummary(undefined, "正在调用 bash")).toBe("正在调用 bash");
    expect(safeToolSummary("   ", "正在调用 bash")).toBe("正在调用 bash");
    expect(safeToolSummary("\u0000\u0007", "正在调用 bash")).toBe("正在调用 bash");
  });
});

describe("readStringField", () => {
  test("reads only non-empty string fields off unknown input", () => {
    expect(readStringField({ command: "ls" }, "command")).toBe("ls");
    expect(readStringField({ command: "" }, "command")).toBeUndefined();
    expect(readStringField({ command: 42 }, "command")).toBeUndefined();
    expect(readStringField(null, "command")).toBeUndefined();
    expect(readStringField("ls", "command")).toBeUndefined();
  });
});

/** Each tool picks the part of its own input that is meaningful to a human;
 *  a wrong guess here is what leaks a command or a path. */
describe("tool describeStart", () => {
  test("bash describes the command", () => {
    const tool = createBashTool({ workspaceRoot: "/tmp", scope: "test" });
    expect(tool.describeStart?.({ command: "bun test apps/backend" })).toBe(
      "正在执行：bun test apps/backend",
    );
    expect(tool.describeStart?.({})).toBe("正在执行命令");
  });

  test("read describes the path", () => {
    const tool = createReadTool({ cwd: "/tmp" });
    expect(tool.describeStart?.({ path: "src/main.ts" })).toBe("正在读取：src/main.ts");
    expect(tool.describeStart?.({})).toBe("正在读取文件");
  });

  test("grep describes pattern and scope", () => {
    const tool = createGrepTool({ workspaceRoot: "/tmp" });
    expect(tool.describeStart?.({ pattern: "TODO", path: "apps" })).toBe("正在搜索：TODO（apps）");
    expect(tool.describeStart?.({ pattern: "TODO" })).toBe("正在搜索：TODO");
    expect(tool.describeStart?.({})).toBe("正在搜索代码");
  });
});
