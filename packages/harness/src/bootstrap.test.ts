import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { consoleLogger } from "@my-agent-team/framework";
import { LocalBackend, WorkspaceFS } from "@my-agent-team/workspace-fs";
import { BOOTSTRAP_TEMPLATE, bootstrap } from "./bootstrap.js";

function testFS(root: string): WorkspaceFS {
  const be = new LocalBackend(root);
  return new WorkspaceFS({ mounts: [
    { prefix: "/shared/", domain: "shared", backend: be },
    { prefix: "/private/", domain: "private", backend: be, posixRoot: root },
  ]});
}

describe("bootstrap", () => {
  const logger = consoleLogger({ level: "silent" });

  // ─── BOOTSTRAP.md tests (M11 genesis) ──────────────────────────

  test("BOOTSTRAP.md present → returns its content directly as systemPrompt", async () => {
    const ws = `/tmp/test-bootstrap-boot-${Date.now()}`;
    await mkdir(ws, { recursive: true });

    try {
      await writeFile(path.join(ws, "BOOTSTRAP.md"), "You just woke up. Talk to the user.");

      const prompt = await bootstrap(testFS(ws), logger);

      expect(prompt).toBe("You just woke up. Talk to the user.");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("BOOTSTRAP.md + SOUL.md → BOOTSTRAP.md is stale, deleted, normal compose", async () => {
    const ws = `/tmp/test-bootstrap-boot2-${Date.now()}`;
    await mkdir(ws, { recursive: true });
    await mkdir(path.join(ws, "memory"), { recursive: true });

    try {
      await writeFile(path.join(ws, "BOOTSTRAP.md"), "boot content");
      // SOUL.md exists → BOOTSTRAP.md is stale leftover, should be cleaned up
      await writeFile(path.join(ws, "SOUL.md"), "i am an agent");

      const prompt = await bootstrap(testFS(ws), logger);

      // Should NOT return boot content (BOOTSTRAP.md was cleaned up)
      expect(prompt).not.toBe("boot content");
      // Should use SOUL.md content in normal compose
      expect(prompt).toInclude("i am an agent");
      // BOOTSTRAP.md should be deleted
      const { existsSync } = await import("node:fs");
      expect(existsSync(path.join(ws, "BOOTSTRAP.md"))).toBe(false);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("BOOTSTRAP.md present alone (no SOUL.md) → birth mode", async () => {
    const ws = `/tmp/test-bootstrap-boot3-${Date.now()}`;
    await mkdir(ws, { recursive: true });

    try {
      await writeFile(path.join(ws, "BOOTSTRAP.md"), "genesis prompt");

      const prompt = await bootstrap(testFS(ws), logger);

      // No SOUL.md → genuine birth mode, return BOOTSTRAP.md content
      expect(prompt).toBe("genesis prompt");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("empty workspace + no BOOTSTRAP.md → returns BOOTSTRAP_TEMPLATE (genesis fallback)", async () => {
    const ws = `/tmp/test-bootstrap-empty-${Date.now()}`;
    await mkdir(ws, { recursive: true });

    try {
      const prompt = await bootstrap(testFS(ws), logger);

      // Should be the genesis template, not the old fallback
      expect(prompt).toInclude("You just woke up");
      expect(prompt).toInclude("BOOTSTRAP.md");
      expect(prompt).not.toInclude("generic agent");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("BOOTSTRAP_TEMPLATE is a non-empty string", () => {
    expect(BOOTSTRAP_TEMPLATE.length).toBeGreaterThan(100);
    expect(BOOTSTRAP_TEMPLATE).toInclude("SOUL.md");
    expect(BOOTSTRAP_TEMPLATE).toInclude("BOOTSTRAP.md");
  });

  // ─── Regression: existing bootstrap behavior untouched ─────────

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

      const prompt = await bootstrap(testFS(ws), logger);

      expect(prompt).toInclude("<workspace>");
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

      const prompt = await bootstrap(testFS(ws), logger);

      expect(prompt).toInclude("only soul");
      // Other sections should still exist with empty shells
      expect(prompt).toInclude("<user>\n\n</user>");
      expect(prompt).toInclude("<tools>\n\n</tools>");
      expect(prompt).toInclude("<agents>\n\n</agents>");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("IO error degrades to genesis template", async () => {
    // Points to a non-existent workspace root
    // All files missing → BOOTSTRAP_TEMPLATE fallback
    const ws = `/tmp/test-bootstrap-nonexistent-${Date.now()}`;

    const prompt = await bootstrap(testFS(ws), logger);

    // Should return genesis template, not old "generic agent" fallback
    expect(prompt).toInclude("You just woke up");
    expect(prompt).not.toInclude("generic agent");
  });
});

function isoStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
