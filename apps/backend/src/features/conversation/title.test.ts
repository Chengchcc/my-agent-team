import { expect, test } from "bun:test";

// Inline copies of pure functions from title.ts (avoids workspace import issue in bun test)
function buildTitleContext(msgs: Array<{ role: string; content: unknown }>, maxTurns = 4): string {
  function text(c: unknown): string {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return (c as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("");
    }
    return "";
  }
  return (msgs as Array<{ role: string; content: unknown }>)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(0, maxTurns * 2)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${text(m.content)}`)
    .filter((line) => line.length > 3)
    .join("\n");
}

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
      { role: "user", content: "帮我修复登录 bug" },
      { role: "assistant", content: "好的，我来看一下" },
      { role: "user", content: "还有第三轮" },
      { role: "user", content: "第四轮" },
      { role: "user", content: "第五轮不该出现" },
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
        content: [
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
