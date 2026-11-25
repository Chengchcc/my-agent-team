/** What a stored artifact is, as the gallery's filters name it — and, for a
 *  diff, what it changes. Pure: names, MIME types and text in; kinds and rows
 *  out. Nothing here downloads, writes or accepts anything. */

export type ArtifactKind = "change" | "visual" | "document" | "other";

const CHANGE_NAME = /\.(diff|patch)$/;
const CHANGE_MIME = /diff|patch/;
const VISUAL_NAME = /\.(svg|webp|avif|ico)$/;
const DOCUMENT_NAME =
  /\.(md|markdown|txt|json|yml|yaml|csv|pdf|html|htm|docx|doc|ts|tsx|js|jsx|py|sh|log)$/;
const DOCUMENT_MIME = /^(text\/|application\/(json|xml|yaml|pdf|rtf))/;

/** The product names a file's type by its extension, so `.diff` and `.svg`
 *  arrive as `application/octet-stream`; the name decides for those. */
export function artifactKind(meta: { filename: string; mimeType: string }): ArtifactKind {
  const name = meta.filename.toLowerCase();
  const mime = meta.mimeType.toLowerCase();
  if (CHANGE_NAME.test(name)) return "change";
  if (CHANGE_MIME.test(mime)) return "change";
  if (mime.startsWith("image/")) return "visual";
  if (VISUAL_NAME.test(name)) return "visual";
  if (DOCUMENT_MIME.test(mime)) return "document";
  if (DOCUMENT_NAME.test(name)) return "document";
  return "other";
}

export type DiffRowKind = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffRow {
  readonly kind: DiffRowKind;
  /** The line without its leading marker. */
  readonly text: string;
  /** Line numbers in the old and the new file; null outside file content. */
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

export interface DiffFile {
  readonly path: string;
  readonly rows: readonly DiffRow[];
  readonly additions: number;
  readonly deletions: number;
}

export interface DiffView {
  readonly files: readonly DiffFile[];
  readonly additions: number;
  readonly deletions: number;
}

const GIT_HEADER = /^diff --git \S+ (.+)$/;
const PATCH_HEADER = /^\+\+\+ (.+)$/;
const HUNK = /^@@ -(\d+)[^ ]* \+(\d+)[^ ]* @@/;
/** First lines of the formats tools write: git, `diff -u`, `Index:`. */
const DIFF_START = /^(diff --git |Index: |@@ -\d+ |--- \S)/m;
const GIT_START = /^diff --git /m;
const NO_PATH = "(no file header)";
const NO_FILE = "/dev/null";

/** A file whose name does not say "diff" can still hold one; read the text. */
export function looksLikeDiff(text: string): boolean {
  return DIFF_START.test(text);
}

interface Section {
  path: string;
  rows: DiffRow[];
  additions: number;
  deletions: number;
}

/** A unified or git diff, split into one section per file with its rows and
 *  counts. Text that is not a diff yields no files. */
export function parseDiff(text: string): DiffView {
  const files: DiffFile[] = [];
  // The section being read; it is pushed when the next file header starts.
  let section: Section = { path: NO_PATH, rows: [], additions: 0, deletions: 0 };
  let started = false;
  let oldNo = 0;
  let newNo = 0;
  // A git diff names each file on its `diff --git` line and repeats it on the
  // `---` / `+++` lines; only the first counts, or each file would appear twice.
  const gitStyle = GIT_START.test(text);

  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const git = GIT_HEADER.exec(line);
    const patch = PATCH_HEADER.exec(line);
    const hunk = HUNK.exec(line);
    const newByPatch = patch !== null && patch[1] !== NO_FILE && !gitStyle;
    if (git !== null || newByPatch) {
      if (started) files.push(section);
      started = true;
      const named = git !== null ? git[1] : patch?.[1];
      const path = (named ?? NO_PATH).replace(/^[ab]\//, "");
      section = { path, rows: [], additions: 0, deletions: 0 };
      section.rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (hunk !== null) {
      oldNo = Number.parseInt(hunk[1] ?? "1", 10);
      newNo = Number.parseInt(hunk[2] ?? "1", 10);
      section.rows.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
      continue;
    }
    const mark = line.charAt(0);
    const isAdd = mark === "+" && !line.startsWith("+++ ");
    const isDel = mark === "-" && !line.startsWith("--- ");
    const isContext = mark === " " || line === "";
    if (isAdd) {
      section.additions += 1;
      section.rows.push({ kind: "add", text: line.slice(1), oldNo: null, newNo });
      newNo += 1;
    } else if (isDel) {
      section.deletions += 1;
      section.rows.push({ kind: "del", text: line.slice(1), oldNo, newNo: null });
      oldNo += 1;
    } else if (isContext) {
      // An empty line is a context line whose leading space a tool stripped.
      section.rows.push({ kind: "ctx", text: line.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    } else {
      section.rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    }
  }
  if (started) files.push(section);

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return { files, additions, deletions };
}
