import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import type { Tool } from "@chengchenccc/message";
import {
  computeFileFingerprint,
  fingerprintFile,
  fingerprintFooter,
  MISSING_FINGERPRINT_HINT,
  STALE_FINGERPRINT_HINT,
} from "./file-fingerprint.js";
import { WorkspaceSandbox } from "./workspace-sandbox.js";

type InputRec = Record<string, unknown>;

/** Freshness policy for the file tools.
 *
 *  "require": `read` appends an `[fingerprint <12hex>]` trailer, and `edit` /
 *  `write` refuse to touch EXISTING content unless the call echoes that value
 *  for the file as it is now. This is the "read before edit" restriction other
 *  harnesses enforce, enforced on the content instead of on a read-history flag
 *  (see file-fingerprint.ts for why).
 *
 *  "off" (default): no trailer, no check — the behaviour every non-runtime
 *  caller and test has today. The runtime assembly opts in; a bare
 *  `createReadTool({cwd})` stays usable. */
export type FileFreshness = "off" | "require";

/** The fingerprint a later call must echo, or a refusal. `undefined` when the
 *  path has no current content — a new file has nothing to protect. */
function checkFreshness(
  full: string,
  provided: unknown,
): { content: string; isError: true } | undefined {
  const current = fingerprintFile(full);
  if (current === undefined) return undefined; // absent/unreadable: nothing to clobber
  const given = typeof provided === "string" ? provided.trim() : "";
  if (given === "") {
    return {
      content: `Error: no fingerprint for this file. ${MISSING_FINGERPRINT_HINT}, so the write cannot land on content you have not seen.`,
      isError: true,
    };
  }
  if (given !== current) {
    return {
      content: `Error: refused to write — ${STALE_FINGERPRINT_HINT}.`,
      isError: true,
    };
  }
  return undefined;
}

function safePath(cwd: string, userPath: string): string | null {
  try {
    const sandbox = new WorkspaceSandbox(cwd);
    return sandbox.validate(userPath);
  } catch {
    return null;
  }
}

function safePathNew(cwd: string, userPath: string): string | null {
  try {
    const sandbox = new WorkspaceSandbox(cwd);
    return sandbox.validateNew(userPath);
  } catch {
    return null;
  }
}

/** Product-managed config files the agent must never write (H1): a tampered
 *  `.mcp.json` mounts arbitrary stdio servers on every future run (zero
 *  approval — mount is not a tool call) and can exfiltrate a live bearer
 *  via an injected ${VAR} placeholder. The spawner-side bridge is the only
 *  author; these paths are read-only for the model. oma holds no product
 *  FILE names either: anything directly under `.oma/` ending in .json is
 *  product-managed state (settings, bridge manifests); the agent's own
 *  state (rules/*.md, artifacts, screenshots) stays writable. */
const PROTECTED_FILES: Record<string, true> = {
  ".mcp.json": true,
  "mcp.json": true,
  ".oma/settings.json": true,
  ".claude/settings.json": true,
};

function isProtectedPath(cwd: string, full: string): boolean {
  // `full` comes from WorkspaceSandbox, which resolves the root's realpath;
  // canonicalize `cwd` the same way or a symlinked workspace root (macOS
  // /tmp -> /private/tmp) makes `relative` walk up to `../../private/...` and
  // every protected entry misses — the H1 write-any-.mcp.json bypass.
  let root = cwd;
  try {
    root = realpathSync(cwd);
  } catch {
    /* cwd vanished between validate and check; fall back to the raw path */
  }
  const rel = relative(root, full).split(sep).join("/");
  if (PROTECTED_FILES[rel] === true) return true;
  // Generic rule: `.oma/<name>.json` (direct child) is product-managed.
  return /^\.oma\/[^/]+\.json$/.test(rel);
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".ico",
]);
const READ_MAX_SIZE_BYTES = 256 * 1024;

/** Shared "description" parameter - forces the model to explain its intent before each tool call. */
const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining why this tool is being called.",
};

// ─── read ──────────────────────────────────────────────────────

/** Create a read-file tool scoped to a cwd. */
export function createReadTool(opts: { cwd: string; freshness?: FileFreshness }): Tool {
  const { cwd } = opts;
  const freshness = opts.freshness ?? "off";
  return {
    name: "read",
    description:
      "Read a file from the workspace. Returns file contents with line numbers (line\\tcontent). " +
      "For images, returns a placeholder with file size. Output capped at 256KB; use offset/limit for large files." +
      (freshness === "require"
        ? " The trailing [fingerprint ...] line covers the whole file: pass it to edit/write."
        : ""),
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        path: {
          type: "string",
          description: "Path to the file to read, relative to workspace root",
        },
        offset: {
          type: "number",
          description: "1-based line number to start reading from. Defaults to 1.",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read from offset.",
        },
      },
      required: ["path"],
    },
    async execute(input: unknown) {
      const rec = input as InputRec;
      const full = safePath(cwd, String(rec.path ?? ""));
      if (!full) return { content: "Error: path escapes workspace", isError: true };
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          return { content: `Error: ${rec.path} is a directory, not a file.`, isError: true };
        }
        if (IMAGE_EXTENSIONS.has(extname(full).toLowerCase())) {
          return { content: `[image file: ${rec.path} (${stat.size} bytes)]` };
        }
        const content = readFileSync(full, "utf-8");
        const lines = content.split("\n");
        const offset = typeof rec.offset === "number" ? rec.offset : undefined;
        const limit = typeof rec.limit === "number" ? rec.limit : undefined;
        const start = offset && offset > 1 ? offset - 1 : 0;
        const end = limit !== undefined ? start + Math.max(0, limit) : lines.length;
        const selected = lines.slice(start, Math.max(start, end));

        const out: string[] = [];
        let bytes = 0;
        let truncated = false;
        for (let i = 0; i < selected.length; i++) {
          const rendered = `${start + i + 1}\t${selected[i]}`;
          const size = Buffer.byteLength(rendered, "utf8") + 1;
          if (out.length > 0 && bytes + size > READ_MAX_SIZE_BYTES) {
            truncated = true;
            break;
          }
          bytes += size;
          out.push(rendered);
        }

        let result = out.join("\n");
        if (truncated) {
          result += `\n... [truncated at ${READ_MAX_SIZE_BYTES} bytes; pass offset/limit to read a specific range]`;
        }
        // Fingerprint of the WHOLE file (not the returned window): an edit may
        // anchor outside the window the model chose to read.
        if (freshness === "require") result += fingerprintFooter(computeFileFingerprint(content));
        return { content: result };
      } catch (err) {
        return {
          content: `Error reading file: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  };
}

// ─── write ─────────────────────────────────────────────────────

/** Create a write-file tool scoped to a cwd. */
export function createWriteTool(opts: { cwd: string; freshness?: FileFreshness }): Tool {
  const { cwd } = opts;
  const freshness = opts.freshness ?? "off";
  return {
    name: "write",
    description:
      "Write content to a file in the workspace. Creates parent directories if needed. Overwrites if file exists." +
      (freshness === "require"
        ? " Overwriting an existing file requires the fingerprint from a prior read of it."
        : ""),
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        path: {
          type: "string",
          description: "Path to the file to write, relative to workspace root",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
        ...(freshness === "require"
          ? {
              fingerprint: {
                type: "string",
                description:
                  "The [fingerprint ...] value from a read of this file. Required when the file already exists.",
              },
            }
          : {}),
      },
      required: ["path", "content"],
    },
    async execute(input: unknown) {
      const rec = input as InputRec;
      const full = safePathNew(cwd, String(rec.path ?? ""));
      if (!full) return { content: "Error: path escapes workspace", isError: true };
      if (isProtectedPath(cwd, full)) {
        return {
          content: `Error: ${rec.path} is product-managed and read-only for the agent`,
          isError: true,
        };
      }
      if (freshness === "require") {
        const refusal = checkFreshness(full, rec.fingerprint);
        if (refusal) return refusal;
      }
      try {
        mkdirSync(resolve(full, ".."), { recursive: true });
        const content = String(rec.content ?? "");
        writeFileSync(full, content, "utf-8");
        return { content: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rec.path}` };
      } catch (err) {
        return {
          content: `Error writing file: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  };
}

// ─── edit ──────────────────────────────────────────────────────

/** Create an edit-file tool scoped to a cwd. */
export function createEditTool(opts: { cwd: string; freshness?: FileFreshness }): Tool {
  const { cwd } = opts;
  const freshness = opts.freshness ?? "off";
  return {
    name: "edit",
    description:
      "Perform exact string replacement in a file. old_string must match exactly and be unique " +
      "unless replace_all is set. Use for surgical edits; prefer write for full replacement." +
      (freshness === "require" ? " Requires the fingerprint from a prior read of the file." : ""),
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        path: {
          type: "string",
          description: "Path to the file to edit, relative to workspace root",
        },
        old_string: {
          type: "string",
          description: "The exact text to replace (must be unique unless replace_all is true)",
        },
        new_string: {
          type: "string",
          description: "The replacement text (must differ from old_string)",
        },
        replace_all: {
          type: "boolean",
          description: "Replace all occurrences. Defaults to false (first match only).",
        },
        ...(freshness === "require"
          ? {
              fingerprint: {
                type: "string",
                description: "The [fingerprint ...] value from a read of this file.",
              },
            }
          : {}),
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute(input: unknown) {
      const rec = input as InputRec;
      const full = safePath(cwd, String(rec.path ?? ""));
      if (!full) return { content: "Error: path escapes workspace", isError: true };
      if (isProtectedPath(cwd, full)) {
        return {
          content: `Error: ${rec.path} is product-managed and read-only for the agent`,
          isError: true,
        };
      }
      if (freshness === "require" && existsSync(full)) {
        const refusal = checkFreshness(full, rec.fingerprint);
        if (refusal) return refusal;
      }
      try {
        if (!existsSync(full)) {
          return { content: `Error: file not found: ${rec.path}`, isError: true };
        }
        const oldStr = String(rec.old_string ?? "");
        const newStr = String(rec.new_string ?? "");
        const replaceAll = rec.replace_all === true;

        if (oldStr === newStr) {
          return { content: "Error: new_string must differ from old_string.", isError: true };
        }
        if (oldStr === "") {
          return {
            content:
              "Error: old_string is empty, so this call cannot change anything. Provide the text to replace.",
            isError: true,
          };
        }

        const content = readFileSync(full, "utf-8");
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) {
          return {
            content:
              "Error: old_string not found in file. The file may have changed since you last read it.",
            isError: true,
          };
        }
        if (!replaceAll && occurrences > 1) {
          return {
            content: `Error: old_string is not unique (${occurrences} matches). Provide a larger unique string or set replace_all.`,
            isError: true,
          };
        }

        // newStr is model-supplied text, so it must land verbatim: with a
        // STRING replacement, String.replace expands `$&`, `$$`, `$'`, `` $` ``
        // and `$n` against the match, so the tool would report success while
        // writing different bytes. The replace_all branch (split/join) has no
        // such expansion, so both paths must agree here.
        const newContent = replaceAll
          ? content.split(oldStr).join(newStr)
          : content.replace(oldStr, () => newStr);
        writeFileSync(full, newContent, "utf-8");
        const count = replaceAll ? occurrences : 1;
        return { content: `Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${rec.path}` };
      } catch (err) {
        return {
          content: `Error editing file: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  };
}
