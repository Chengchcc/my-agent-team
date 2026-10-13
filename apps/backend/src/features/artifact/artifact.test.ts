import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactFsAdapter } from "./adapter-fs.js";
import { parseArtifactUrl, splitPath } from "./domain.js";
import { createArtifactService } from "./service.js";

test("parse artifact url and path safety", () => {
  expect(parseArtifactUrl("artifacts://report/2026/detail.md")).toEqual({
    folder: "report/2026",
    filename: "detail.md",
  });
  expect(() => splitPath("../evil/x.txt")).toThrow(/unsafe/);
  expect(() => splitPath("/abs/x.txt")).toThrow(/unsafe/);
  expect(() => splitPath("a/../../x.txt")).toThrow(/unsafe/);
});

test("the filename segment is checked too, not just the folder", () => {
  // These reach the filename guard at the end of splitPath. Disabling it used
  // to survive the whole suite, and an artifact filename does reach the
  // filesystem - the earlier cases all threw in the folder loop first.
  for (const bad of ["folder/..", "folder/.", "folder/*"]) {
    expect(() => splitPath(bad), bad).toThrow(/unsafe artifact filename/);
  }
  expect(splitPath("shots/one.png")).toEqual(["shots", "one.png"]);
  expect(splitPath("shots\\one.png")).toEqual(["shots", "one.png"]);
});

test("an upload records the sha256 of the bytes it wrote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "art-hash-"));
  const svc = createArtifactService(createArtifactFsAdapter(dir));
  const text = await svc.upload({ folder: "ledger", filename: "a.txt", content: "hello" });
  const want = createHash("sha256").update(Buffer.from("hello", "utf8")).digest("hex");
  expect(text.sha256).toBe(want);
  // Binary uploads hash the DECODED bytes, never the base64 text.
  const raw = Buffer.from([0, 1, 2, 250, 251]);
  const bin = await svc.upload({
    folder: "ledger",
    filename: "b.bin",
    content: raw.toString("base64"),
    encoding: "base64",
  });
  expect(bin.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
  // The sidecar IS the ledger: a later listing reports the same number.
  const back = (await svc.list("ledger")).find((m) => m.filename === "a.txt");
  expect(back?.sha256).toBe(want);
});

test("verify re-reads the bytes and compares them with the ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "art-verify-"));
  const svc = createArtifactService(createArtifactFsAdapter(dir));
  const m = await svc.upload({ folder: "v", filename: "x.txt", content: "abc" });
  const verdict = await svc.verify(m.url);
  expect(verdict?.ok).toBe(true);
  expect(verdict?.actual).toBe(m.sha256);
  expect(verdict?.expected).toBe(m.sha256);
  writeFileSync(join(dir, "v", "x.txt"), "tampered");
  const bad = await svc.verify(m.url);
  expect(bad?.ok).toBe(false);
  expect(bad?.actual).not.toBe(bad?.expected);
  // Absent file: nothing to verify (distinct from a mismatch).
  expect(await svc.verify("artifacts://v/nope.txt")).toBeNull();
});

test("deleting an artifact takes its sidecar with it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "art-del-"));
  const svc = createArtifactService(createArtifactFsAdapter(dir));
  const m = await svc.upload({ folder: "d", filename: "y.txt", content: "y" });
  expect(existsSync(join(dir, "d", "y.txt.meta.json"))).toBe(true);
  expect(await svc.delete(m.url)).toBe(true);
  expect(existsSync(join(dir, "d", "y.txt"))).toBe(false);
  // The sidecar used to survive its artifact: invisible junk that piled up.
  expect(existsSync(join(dir, "d", "y.txt.meta.json"))).toBe(false);
});

test("list reports the recorded encoding instead of guessing utf8", async () => {
  const dir = mkdtempSync(join(tmpdir(), "art-enc-"));
  const svc = createArtifactService(createArtifactFsAdapter(dir));
  const raw = Buffer.from([0, 1, 2, 250]);
  await svc.upload({
    folder: "e",
    filename: "z.bin",
    content: raw.toString("base64"),
    encoding: "base64",
  });
  const listed = (await svc.list("e")).find((m) => m.filename === "z.bin");
  expect(listed?.encoding).toBe("base64");
});

test("retention is opt-in and never touches fresh artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "art-ret-"));
  const svc = createArtifactService(createArtifactFsAdapter(dir));
  const old = await svc.upload({ folder: "r", filename: "old.txt", content: "old" });
  const fresh = await svc.upload({ folder: "r", filename: "fresh.txt", content: "fresh" });
  const past = new Date(Date.now() - 40 * 24 * 3600_000);
  utimesSync(join(dir, "r", "old.txt"), past, past);
  utimesSync(join(dir, "r", "old.txt.meta.json"), past, past);

  // 0 = keep forever: the sweep must be a no-op, not a wipe.
  expect(await svc.purgeOlderThan(0)).toBe(0);
  expect(await svc.exists(old.url)).toBe(true);
  // Anything in the window stays; the one past it goes, sidecar included.
  expect(await svc.purgeOlderThan(30)).toBe(1);
  expect(await svc.exists(old.url)).toBe(false);
  expect(await svc.exists(fresh.url)).toBe(true);
  expect(existsSync(join(dir, "r", "old.txt.meta.json"))).toBe(false);
});

test("upload and download utf8 + base64", async () => {
  const dir = mkdtempSync(join(tmpdir(), "art-"));
  const svc = createArtifactService(createArtifactFsAdapter(dir));
  const m = await svc.upload({
    folder: "report/2026",
    filename: "q.md",
    content: "# hi",
    source: { runId: "r1", conversationId: "c1", agentId: "a1" },
  });
  expect(m.url).toBe("artifacts://report/2026/q.md");
  const got = await svc.download(m.url);
  expect(got.content).toBe("# hi");
  expect(got.mimeType).toBe("text/markdown");
  expect(await svc.exists(m.url)).toBe(true);

  const bin = await svc.upload({
    folder: "img",
    filename: "p.png",
    content: Buffer.from([1, 2, 3]).toString("base64"),
    encoding: "base64",
  });
  const bg = await svc.download(bin.url);
  expect(bg.encoding).toBe("base64");
  expect(Buffer.from(bg.content, "base64")).toEqual(Buffer.from([1, 2, 3]));
});

test("list and delete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "art-"));
  const svc = createArtifactService(createArtifactFsAdapter(dir));
  await svc.upload({ folder: "a", filename: "x.txt", content: "x" });
  await svc.upload({ folder: "a/b", filename: "y.json", content: "{}" });
  const all = await svc.list();
  expect(all.length).toBe(2);
  const a = await svc.list("a");
  expect(a.length).toBe(2);
  const ab = await svc.list("a/b");
  expect(ab.length).toBe(1);
  await svc.delete("artifacts://a/x.txt");
  expect(await svc.exists("artifacts://a/x.txt")).toBe(false);
});

test("list rejects folders escaping the root (M13)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "art-"));
  const adapter = createArtifactFsAdapter(dir);
  // Pre-M13 the guard only checked in-root paths, so an escaped dir was
  // walked synchronously (existence oracle + name enumeration).
  await expect(adapter.list("../outside")).rejects.toThrow(/escapes root/);
  await expect(adapter.list("a/../../../etc")).rejects.toThrow(/escapes root/);
});
