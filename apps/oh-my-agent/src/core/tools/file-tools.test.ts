import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditTool, createReadTool, createWriteTool } from "./file-tools.js";

/** H1: product-managed config files are read-only for the agent — a tampered
 *  .mcp.json would mount arbitrary servers with zero approval. */
describe("write/edit protect product config files (H1)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-prot-"));

  test("write refuses .mcp.json", async () => {
    const res = await createWriteTool({ cwd }).execute({ path: ".mcp.json", content: "{}" });
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/product-managed/);
  });

  test("write refuses nested .oma/product-tools.json", async () => {
    const res = await createWriteTool({ cwd }).execute({
      path: ".oma/product-tools.json",
      content: "[]",
    });
    expect(res.isError).toBe(true);
  });

  test("edit refuses .claude/settings.json", async () => {
    const res = await createEditTool({ cwd }).execute({
      path: ".claude/settings.json",
      old_string: "a",
      new_string: "b",
    });
    expect(res.isError).toBe(true);
  });

  test("write still allows normal files", async () => {
    const res = await createWriteTool({ cwd }).execute({ path: "notes/a.md", content: "hi" });
    expect(res.isError).toBeUndefined();
  });
});

describe("read: line numbers, ranges, size guard", () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-read-"));

  test("returns 1-based line numbers and respects offset/limit", async () => {
    const read = createReadTool({ cwd });
    await createWriteTool({ cwd }).execute({
      path: "notes/p.txt",
      content: "alpha\nbeta\ngamma\ndelta\n",
    });
    const all = await read.execute({ path: "notes/p.txt" });
    expect(all.content).toBe("1\talpha\n2\tbeta\n3\tgamma\n4\tdelta\n5\t");
    // offset is 1-based and inclusive; limit caps the window.
    const window = await read.execute({ path: "notes/p.txt", offset: 2, limit: 2 });
    expect(window.content).toBe("2\tbeta\n3\tgamma");
  });

  test("a missing file and a directory are tool errors, never throws", async () => {
    const read = createReadTool({ cwd });
    const missing = await read.execute({ path: "nope.txt" });
    expect(missing.isError).toBe(true);
    const dir = await read.execute({ path: "notes" });
    expect(dir.isError).toBe(true);
    expect(String(dir.content)).toContain("is a directory");
  });

  test("image extensions return a placeholder instead of binary garbage", async () => {
    const read = createReadTool({ cwd });
    await createWriteTool({ cwd }).execute({ path: "a.png", content: "not-really-a-png" });
    const res = await read.execute({ path: "a.png" });
    expect(res.content).toMatch(/^\[image file: a\.png \(\d+ bytes\)\]$/);
  });

  test("output is capped at 256KB with a truncation hint", async () => {
    const read = createReadTool({ cwd });
    // 400 lines x 1KB ≈ 400KB > the 256KB cap.
    const big = Array.from({ length: 400 }, (_, i) => `line-${i}-${"x".repeat(1024)}`).join("\n");
    await createWriteTool({ cwd }).execute({ path: "big.txt", content: big });
    const res = await read.execute({ path: "big.txt" });
    expect(String(res.content)).toContain("truncated at");
    expect(Buffer.byteLength(String(res.content), "utf8")).toBeLessThan(300 * 1024);
  });
});

describe("path containment (workspace escape is refused, not silently clamped)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-esc-"));

  test("read/write/edit all refuse escapes", async () => {
    const read = await createReadTool({ cwd }).execute({ path: "../../etc/passwd" });
    expect(read.isError).toBe(true);
    expect(String(read.content)).toContain("escapes workspace");

    const write = await createWriteTool({ cwd }).execute({
      path: "../outside.txt",
      content: "x",
    });
    expect(write.isError).toBe(true);

    const edit = await createEditTool({ cwd }).execute({
      path: "../../etc/hosts",
      old_string: "a",
      new_string: "b",
    });
    expect(edit.isError).toBe(true);
  });

  test("an absolute path outside the workspace is refused too", async () => {
    const res = await createWriteTool({ cwd }).execute({
      path: "/tmp/oma-escape.txt",
      content: "x",
    });
    expect(res.isError).toBe(true);
  });
});

describe("edit semantics", () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-edit-"));

  async function seed(content: string): Promise<string> {
    await createWriteTool({ cwd }).execute({ path: "e.txt", content });
    return "e.txt";
  }

  test("non-unique old_string is refused unless replace_all", async () => {
    const p = await seed("dup\ndup\n");
    const edit = createEditTool({ cwd });
    const refused = await edit.execute({ path: p, old_string: "dup", new_string: "one" });
    expect(refused.isError).toBe(true);
    expect(String(refused.content)).toContain("not unique");

    const all = await edit.execute({
      path: p,
      old_string: "dup",
      new_string: "one",
      replace_all: true,
    });
    expect(all.content).toContain("Replaced 2 occurrences");
    const after = await createReadTool({ cwd }).execute({ path: p });
    expect(after.content).toBe("1\tone\n2\tone\n3\t");
  });

  test("missing old_string, identical strings, and missing file are errors", async () => {
    const p = await seed("hello world");
    const edit = createEditTool({ cwd });
    expect((await edit.execute({ path: p, old_string: "absent", new_string: "x" })).isError).toBe(
      true,
    );
    expect((await edit.execute({ path: p, old_string: "a", new_string: "a" })).isError).toBe(true);
    expect(
      (await edit.execute({ path: "ghost.txt", old_string: "a", new_string: "b" })).isError,
    ).toBe(true);
  });

  test("write creates parent directories and reports the byte count", async () => {
    const res = await createWriteTool({ cwd }).execute({
      path: "deep/nested/dir/f.txt",
      content: "héllo",
    });
    expect(res.isError).toBeUndefined();
    // Byte count, not char count: "héllo" is 6 bytes in UTF-8.
    expect(res.content).toBe("Wrote 6 bytes to deep/nested/dir/f.txt");
  });

  test("write→read round-trips non-ASCII content", async () => {
    await createWriteTool({ cwd }).execute({ path: "uni.txt", content: "中文内容" });
    const res = await createReadTool({ cwd }).execute({ path: "uni.txt" });
    expect(res.content).toBe("1\t中文内容");
  });
});
