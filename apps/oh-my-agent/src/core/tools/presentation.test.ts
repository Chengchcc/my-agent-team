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
    expect(safeToolSummary("curl -u alice:hunter2 https://api.example.com", "f")).toBe(
      "curl [已隐藏] https://api.example.com",
    );
    expect(safeToolSummary("curl --user alice:hunter2 https://x.test", "f")).toBe(
      "curl [已隐藏] https://x.test",
    );
    expect(safeToolSummary("curl -H 'Authorization: Basic YWxpY2U6aHVudGVyMg=='", "f")).toBe(
      "curl -H 'Authorization: [已隐藏]'",
    );
  });

  test("over-redaction is bounded: a plain -u flag survives", () => {
    // `sort -u` is not a credential; requiring the user:pass colon keeps the
    // activity readable instead of hiding a flag that means nothing secret.
    expect(safeToolSummary("sort -u names.txt | head", "f")).toBe("sort -u names.txt | head");
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
    // Structured form: the card renders title + detail, and the detail is the
    // only place the command appears (never the raw args record).
    expect(tool.describeStart?.({ command: "bun test apps/backend" })).toEqual({
      title: "运行命令",
      detail: "bun test apps/backend",
      icon: "command",
      visibility: "expandable",
    });
    expect(tool.describeStart?.({})).toEqual({
      title: "运行命令",
      icon: "command",
      visibility: "compact",
    });
  });

  test("read describes the path", () => {
    const tool = createReadTool({ cwd: "/tmp" });
    expect(tool.describeStart?.({ path: "src/main.ts" })).toEqual({
      title: "读取文件",
      detail: "src/main.ts",
      icon: "read",
      visibility: "compact",
    });
    expect(tool.describeStart?.({})).toEqual({
      title: "读取文件",
      icon: "read",
      visibility: "compact",
    });
  });

  test("grep describes pattern and scope", () => {
    const tool = createGrepTool({ workspaceRoot: "/tmp" });
    expect(tool.describeStart?.({ pattern: "TODO", path: "apps" })).toEqual({
      title: "搜索代码",
      detail: "TODO（apps）",
      icon: "search",
      visibility: "compact",
    });
    expect(tool.describeStart?.({ pattern: "TODO" })).toEqual({
      title: "搜索代码",
      detail: "TODO",
      icon: "search",
      visibility: "compact",
    });
    expect(tool.describeStart?.({})).toEqual({
      title: "搜索代码",
      icon: "search",
      visibility: "compact",
    });
  });
});
