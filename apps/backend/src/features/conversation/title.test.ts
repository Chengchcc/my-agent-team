import { expect, test } from "bun:test";
import { buildTitleContext } from "./title.js";

function sanitizeTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'「『]|["'」』]$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 60);
}

test("buildTitleContext extracts first N turns", () => {
  const ctx = buildTitleContext(
    [
      { role: "user", text: "帮我修复登录 bug" },
      { role: "assistant", text: "好的，我来看一下" },
      { role: "user", text: "还有第三轮" },
      { role: "user", text: "第四轮" },
      { role: "user", text: "第五轮不该出现" },
    ],
    2,
  );
  expect(ctx).toContain("帮我修复登录 bug");
  expect(ctx).not.toContain("第五轮");
});

test("buildTitleContext handles ContentBlock[] content", () => {
  const ctx = buildTitleContext(
    [
      {
        role: "user",
        blocks: [
          { type: "text", text: "你好世界" },
          { type: "tool_use", id: "1", name: "bash", input: {} },
        ],
      },
    ],
    1,
  );
  expect(ctx).toContain("你好世界");
});

test("sanitizeTitle strips quotes and truncates", () => {
  expect(sanitizeTitle("「登录修复」")).toBe("登录修复");
  expect(sanitizeTitle('"test"')).toBe("test");
  expect(sanitizeTitle("a".repeat(80)).length).toBe(60);
});
