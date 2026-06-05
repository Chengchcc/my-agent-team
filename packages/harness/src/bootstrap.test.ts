import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { consoleLogger } from "@my-agent-team/framework";
import { bootstrap } from "./bootstrap.js";

describe("bootstrap", () => {
  const logger = consoleLogger({ level: "silent" });

  test("full workspace: all 6 files compose correctly", async () => {
    const ws = `/tmp/test-bootstrap-${Date.now()}`;
    await mkdir(ws, { recursive: true });
    await mkdir(path.join(ws, "memory"), { recursive: true });

    try {
      await writeFile(path.join(ws, "SOUL.md"), "be helpful");
      await writeFile(path.join(ws, "USER.md"), "dev user");
      await writeFile(path.join(ws, "TOOLS.md"), "bash available");
      await writeFile(path.join(ws, "AGENTS.md"), "be safe");
      await writeFile(path.join(ws, "memory", `${isoStr(new Date())}.md`), "today work");
      const yesterday = isoStr(new Date(Date.now() - 86_400_000));
      await writeFile(path.join(ws, "memory", `${yesterday}.md`), "yesterday work");

      const prompt = await bootstrap(ws, logger);

      expect(prompt).toInclude("<workspace>");
      expect(prompt).toInclude(`Root: ${ws}`);
      expect(prompt).toInclude("<soul>");
      expect(prompt).toInclude("be helpful");
      expect(prompt).toInclude("<user>");
      expect(prompt).toInclude("dev user");
      expect(prompt).toInclude("<tools>");
      expect(prompt).toInclude("bash available");
      expect(prompt).toInclude("<agents>");
      expect(prompt).toInclude("be safe");
      expect(prompt).toInclude("<recent-work>");
      expect(prompt).toInclude("yesterday work");
      expect(prompt).toInclude("today work");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("partial workspace: missing files leave empty sections", async () => {
    const ws = `/tmp/test-bootstrap-${Date.now()}`;
    await mkdir(ws, { recursive: true });

    try {
      // Only SOUL.md exists
      await writeFile(path.join(ws, "SOUL.md"), "only soul");

      const prompt = await bootstrap(ws, logger);

      expect(prompt).toInclude("only soul");
      // Other sections should still exist with empty shells
      expect(prompt).toInclude("<user>\n\n</user>");
      expect(prompt).toInclude("<tools>\n\n</tools>");
      expect(prompt).toInclude("<agents>\n\n</agents>");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("completely empty workspace returns fallback prompt", async () => {
    const ws = `/tmp/test-bootstrap-${Date.now()}`;
    await mkdir(ws, { recursive: true });

    try {
      const prompt = await bootstrap(ws, logger);

      expect(prompt).toInclude("generic agent");
      expect(prompt).toInclude(ws);
      // Should NOT contain the XML tags since it's a fallback
      expect(prompt).not.toInclude("<soul>");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("IO error degrades to empty with warning", async () => {
    // Points to a non-existent workspace root for one specific file
    // All files missing → fallback prompt
    const ws = `/tmp/test-bootstrap-nonexistent-${Date.now()}`;

    const prompt = await bootstrap(ws, logger);

    // Should fall back since no files exist
    expect(prompt).toInclude("generic agent");
  });
});

function isoStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
