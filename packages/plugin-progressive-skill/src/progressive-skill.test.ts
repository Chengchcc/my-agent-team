import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { Message } from "@my-agent-team/core";
import {
  type HookContext,
  consoleLogger,
  inMemoryCheckpointer,
  passthroughContextManager,
} from "@my-agent-team/framework";
import { progressiveSkillPlugin } from "./progressive-skill.js";
import { invalidateSkillCache } from "./cache.js";
import { mkdir, writeFile, rm } from "node:fs/promises";

function testCtx(): HookContext {
  return {
    threadId: "t1",
    logger: consoleLogger({ level: "silent" }),
    checkpointer: inMemoryCheckpointer(),
    contextManager: passthroughContextManager(),
  };
}

describe("progressiveSkillPlugin", () => {
  let dir: string;

  beforeAll(async () => {
    dir = `${import.meta.dir}/test-psk-${crypto.randomUUID()}`;
    await mkdir(`${dir}/pdf-extract`, { recursive: true });
    await writeFile(
      `${dir}/pdf-extract/SKILL.md`,
      [
        "---",
        "name: pdf-extract",
        "description: Extract text from PDF files",
        "---",
        "",
        "# PDF Extract",
        "",
        "To extract PDF content:",
        "1. Run `python ${SKILL_DIR}/extract.py`",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("injects skill index into system message", async () => {
    invalidateSkillCache();
    const plugin = progressiveSkillPlugin({ dir });
    const msgs: Message[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ];

    const result = await plugin.hooks.beforeModel!(testCtx(), msgs);
    expect(result).toHaveLength(2);
    const sysContent = (result[0] as Message).content as string;
    expect(sysContent).toContain("pdf-extract");
    expect(sysContent).toContain("Extract text from PDF files");
    expect(sysContent).toContain("<available-skills>");
  });

  test("empty dir → no injection, no error", async () => {
    const emptyDir = `${import.meta.dir}/test-psk-empty-${crypto.randomUUID()}`;
    await mkdir(emptyDir, { recursive: true });
    try {
      invalidateSkillCache();
      const plugin = progressiveSkillPlugin({ dir: emptyDir });
      const msgs: Message[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ];

      const result = await plugin.hooks.beforeModel!(testCtx(), msgs);
      expect((result[0] as Message).content).toBe("sys");
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  test("dir does not exist → warn + pass through", async () => {
    const badDir = `${import.meta.dir}/nonexistent-${crypto.randomUUID()}`;
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

    const plugin = progressiveSkillPlugin({ dir: badDir });
    const msgs: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];

    const result = await plugin.hooks.beforeModel!(ctx, msgs as Message[]);
    expect(result).toHaveLength(2);
    expect(warnings.some((w) => w.includes("dir not found"))).toBe(true);
  });

  test("no system message → warn + pass through", async () => {
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

    invalidateSkillCache();
    const plugin = progressiveSkillPlugin({ dir });
    const msgs: Message[] = [{ role: "user", content: "hi" }];

    const result = await plugin.hooks.beforeModel!(ctx, msgs as Message[]);
    expect(result).toHaveLength(1);
    expect(warnings.some((w) => w.includes("no system message"))).toBe(true);
  });

  test("plugin exposes skill_load tool", () => {
    const plugin = progressiveSkillPlugin({ dir: "/tmp/test" });
    expect(plugin.tools).toHaveLength(1);
    expect(plugin.tools![0]!.name).toBe("skill_load");
  });

  test("${SKILL_DIR} replaced in body", async () => {
    invalidateSkillCache();
    const tool = progressiveSkillPlugin({ dir }).tools![0]!;
    const result = await tool.execute({ name: "pdf-extract" });
    expect(result.content).toContain("/extract.py");
    expect(result.content).not.toContain("${SKILL_DIR}");
  });

  test("other placeholders like ${HOME} are preserved as-is", async () => {
    const tmpDir = `${import.meta.dir}/test-psk-other-${crypto.randomUUID()}`;
    await mkdir(`${tmpDir}/other-skill`, { recursive: true });
    try {
      await writeFile(
        `${tmpDir}/other-skill/SKILL.md`,
        [
          "---",
          "name: other-skill",
          "description: Tests placeholder preservation",
          "---",
          "",
          "Home dir is ${HOME}, memory is at ${MEMORY_DIR}.",
        ].join("\n"),
      );
      invalidateSkillCache();
      const plugin = progressiveSkillPlugin({ dir: tmpDir });
      const result = await plugin.tools![0]!.execute({ name: "other-skill" });
      expect(result.content).toContain("${HOME}");
      expect(result.content).toContain("${MEMORY_DIR}");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
