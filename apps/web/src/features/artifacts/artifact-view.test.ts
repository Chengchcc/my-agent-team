import { describe, expect, test } from "bun:test";
import { artifactKind, looksLikeDiff, parseDiff } from "./artifact-view";

const GIT_PATCH = [
  "diff --git a/README.md b/README.md",
  "index 0a1b2c3..d4e5f6a 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,3 +1,4 @@",
  " # My agent team",
  "-A collection of runtimes.",
  "+A small team that works toward your goal.",
  "+",
  " Keep the technical notes.",
  "diff --git a/docs/start.md b/docs/start.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/start.md",
  "@@ -0,0 +1,2 @@",
  "+1. Install the workspace.",
  "+2. Give your PA a small, read-only goal.",
  "\\ No newline at end of file",
].join("\n");

const PLAIN_PATCH = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,2 +10,2 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
].join("\n");

describe("artifactKind", () => {
  test("a diff is a change by its name, even when the product calls it a byte stream", () => {
    expect(artifactKind({ filename: "README.patch", mimeType: "application/octet-stream" })).toBe(
      "change",
    );
    expect(artifactKind({ filename: "notes.md", mimeType: "application/x-diff" })).toBe("change");
  });

  test("images are visual, text is a document, the rest is other", () => {
    const samples: Array<[string, string]> = [
      ["logo.svg", "application/octet-stream"],
      ["shot.png", "image/png"],
      ["notes.md", "text/markdown"],
      ["data.csv", "text/csv"],
      ["archive.zip", "application/zip"],
    ];
    const kinds = samples.map(([filename, mimeType]) => artifactKind({ filename, mimeType }));
    expect(kinds).toEqual(["visual", "visual", "document", "document", "other"]);
  });
});

describe("looksLikeDiff", () => {
  test("git, unified and Index formats are recognised; prose is not a diff", () => {
    expect(looksLikeDiff(GIT_PATCH)).toBeTruthy();
    expect(looksLikeDiff(PLAIN_PATCH)).toBeTruthy();
    expect(looksLikeDiff("Index: src/app.ts\n===\n")).toBeTruthy();
    expect(looksLikeDiff("# Notes\n\nSome prose.\n")).toBeFalsy();
  });
});

describe("parseDiff", () => {
  test("a git diff: one section per file, line numbers, and the counts", () => {
    const view = parseDiff(GIT_PATCH);
    expect(view.files.map((file) => file.path)).toEqual(["README.md", "docs/start.md"]);
    const readme = view.files[0];
    expect(readme?.rows.map((row) => row.kind)).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "hunk",
      "ctx",
      "del",
      "add",
      "add",
      "ctx",
    ]);
    expect(readme?.rows.filter((row) => row.kind === "del").map((row) => row.oldNo)).toEqual([2]);
    const added = readme?.rows.filter((row) => row.kind === "add") ?? [];
    expect(added.map((row) => row.newNo)).toEqual([2, 3]);
    expect(readme?.rows.at(-1)).toMatchObject({ kind: "ctx", oldNo: 3, newNo: 4 });
    expect(view.additions).toBe(4);
    expect(view.deletions).toBe(1);
  });

  test("a new file has additions and no deletions; the marker line is not content", () => {
    const view = parseDiff(GIT_PATCH);
    const start = view.files[1];
    expect(start?.additions).toBe(2);
    expect(start?.deletions).toBe(0);
    expect(start?.rows.at(-1)?.kind).toBe("meta");
  });

  test("a plain unified diff names its file on the +++ line", () => {
    const view = parseDiff(PLAIN_PATCH);
    expect(view.files.map((file) => file.path)).toEqual(["src/app.ts"]);
    expect(view.additions).toBe(1);
    expect(view.deletions).toBe(1);
  });

  test("text that is not a diff has no files", () => {
    const view = parseDiff("# Notes\n\nSome prose.\n");
    expect(view.files).toHaveLength(0);
    expect(view.additions).toBe(0);
  });
});
