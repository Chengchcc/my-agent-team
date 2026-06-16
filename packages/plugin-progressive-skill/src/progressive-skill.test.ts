import { describe, expect, test } from "bun:test";
import { AgentFS, MemoryBackend } from "@my-agent-team/agent-fs";
import {
  consoleLogger,
  type HookContext,
  inMemoryCheckpointer,
  passthroughContextManager,
} from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";
import { invalidateSkillCache } from "./cache.js";
import { progressiveSkillPlugin } from "./progressive-skill.js";

/** Mount at "/" so all logical paths route to MemoryBackend */
function testFS(): AgentFS {
  return new AgentFS({
    mounts: [{ prefix: "/", domain: "shared", backend: new MemoryBackend() }],
    aliases: { toCanonical: (p: string) => p },
  });
}

/** Mount ONLY at "/skills/" — other roots throw AgentFsAccessError */
function narrowFS(): AgentFS {
  return new AgentFS({
    mounts: [{ prefix: "/skills/", domain: "shared", backend: new MemoryBackend() }],
    aliases: { toCanonical: (p: string) => p },
  });
}

function testCtx(): HookContext {
  return {
    threadId: "t1",
    logger: consoleLogger({ level: "silent" }),
    checkpointer: inMemoryCheckpointer(),
    contextManager: passthroughContextManager(),
  };
}

const pdfExtractSkillMd = [
  "---",
  "name: pdf-extract",
  "description: Extract text from PDF files",
  "---",
  "",
  "# PDF Extract",
  "",
  "To extract PDF content:",
  "1. Run `python ${SKILL_DIR}/extract.py`",
].join("\n");

describe("progressiveSkillPlugin", () => {
  test("injects skill index into system message", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write("/skills/pdf-extract/SKILL.md", pdfExtractSkillMd);
    invalidateSkillCache(root);

    const plugin = progressiveSkillPlugin({ ws, root });
    const msgs: Message[] = [
      { role: "system", text: "You are helpful." },
      { role: "user", text: "hi" },
    ];

    const result = (await plugin.hooks.beforeModel?.(testCtx(), msgs)) as Message[];
    expect(result).toHaveLength(2);
    const sysContent = (result[0] as Message).text as string;
    expect(sysContent).toContain("pdf-extract");
    expect(sysContent).toContain("Extract text from PDF files");
    expect(sysContent).toContain("<available-skills>");
  });

  test("empty dir → no injection, no error", async () => {
    const ws = testFS();
    const root = "/empty-root/";
    invalidateSkillCache(root);

    const plugin = progressiveSkillPlugin({ ws, root });
    const msgs: Message[] = [
      { role: "system", text: "sys" },
      { role: "user", text: "hi" },
    ];

    const result = (await plugin.hooks.beforeModel?.(testCtx(), msgs)) as Message[];
    expect((result[0] as Message).text).toBe("sys");
  });

  test("dir does not exist → warn + pass through", async () => {
    // Use a narrow mount that only covers /skills/ — /nonexistent/ has no mount
    const ws = narrowFS();
    const root = "/nonexistent/";
    const warnings: string[] = [];
    const ctx = {
      ...testCtx(),
      logger: {
        ...testCtx().logger,
        warn: (msg: string) => {
          warnings.push(msg);
        },
      },
    };

    const plugin = progressiveSkillPlugin({ ws, root });
    const msgs: Message[] = [
      { role: "system", text: "sys" },
      { role: "user", text: "hi" },
    ];

    const result = await plugin.hooks.beforeModel?.(ctx, msgs as Message[]);
    expect(result).toHaveLength(2);
    expect(warnings.some((w) => w.includes("load failed"))).toBe(true);
  });

  test("no system message → warn + pass through", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write("/skills/pdf-extract/SKILL.md", pdfExtractSkillMd);
    invalidateSkillCache(root);

    const warnings: string[] = [];
    const ctx = {
      ...testCtx(),
      logger: {
        ...testCtx().logger,
        warn: (msg: string) => {
          warnings.push(msg);
        },
      },
    };

    const plugin = progressiveSkillPlugin({ ws, root });
    const msgs: Message[] = [{ role: "user", text: "hi" }];

    const result = await plugin.hooks.beforeModel?.(ctx, msgs as Message[]);
    expect(result).toHaveLength(1);
    expect(warnings.some((w) => w.includes("no system message"))).toBe(true);
  });

  test("plugin exposes skill_load tool", () => {
    const ws = testFS();
    const plugin = progressiveSkillPlugin({ ws });
    expect(plugin.tools).toHaveLength(1);
    expect(plugin.tools?.[0]?.name).toBe("skill_load");
  });

  test("${SKILL_DIR} replaced with logical path when no posixSkillRoot", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write("/skills/pdf-extract/SKILL.md", pdfExtractSkillMd);
    invalidateSkillCache(root);

    const tool = progressiveSkillPlugin({ ws, root }).tools![0]!;
    const result = await tool.execute({ name: "pdf-extract" });
    // Falls back to logical path
    expect(result.content).toContain("/skills/pdf-extract/extract.py");
    expect(result.content).not.toContain("${SKILL_DIR}");
  });

  test("${SKILL_DIR} replaced with posixRoot when posixSkillRoot is set", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write("/skills/pdf-extract/SKILL.md", pdfExtractSkillMd);
    invalidateSkillCache(root);

    const tool = progressiveSkillPlugin({
      ws,
      root,
      posixSkillRoot: "/real/skills",
    }).tools![0]!;
    const result = await tool.execute({ name: "pdf-extract" });
    expect(result.content).toContain("/real/skills/pdf-extract/extract.py");
    expect(result.content).not.toContain("${SKILL_DIR}");
  });

  test("other placeholders like ${HOME} are preserved as-is", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write(
      "/skills/other-skill/SKILL.md",
      [
        "---",
        "name: other-skill",
        "description: Tests placeholder preservation",
        "---",
        "",
        "Home dir is ${HOME}, memory is at ${MEMORY_DIR}.",
      ].join("\n"),
    );
    invalidateSkillCache(root);

    const plugin = progressiveSkillPlugin({ ws, root });
    const result = (await plugin.tools?.[0]?.execute({ name: "other-skill" })) as {
      content: string;
    };
    expect(result.content).toContain("${HOME}");
    expect(result.content).toContain("${MEMORY_DIR}");
  });
});
