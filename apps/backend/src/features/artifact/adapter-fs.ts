import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  type ArtifactMeta,
  type ArtifactRef,
  type ArtifactUploadInput,
  artifactUrl,
  parseArtifactUrl,
  splitPath,
} from "./domain.js";
import type { ArtifactPort } from "./ports.js";

function detectMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "text/markdown",
    json: "application/json",
    txt: "text/plain",
    csv: "text/csv",
    html: "text/html",
    yml: "text/yaml",
    yaml: "text/yaml",
    js: "text/javascript",
    ts: "text/typescript",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    pdf: "application/pdf",
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
  };
  return map[ext] ?? "application/octet-stream";
}

export function createArtifactFsAdapter(root: string): ArtifactPort {
  const rootResolved = resolve(root);
  mkdirSync(rootResolved, { recursive: true });

  function safePath(folder: string, filename: string): string {
    const p = resolve(rootResolved, join(folder, filename));
    // Separator matters: without it, "../artifacts-evil" resolves to a
    // sibling whose name shares the prefix and passes a bare startsWith.
    if (p !== rootResolved && !p.startsWith(rootResolved + sep)) {
      throw new Error("artifact path escapes root");
    }
    return p;
  }

  function toMeta(
    ref: ArtifactRef,
    size: number,
    encoding: "utf8" | "base64",
    updatedAt: number,
    source?: ArtifactUploadInput["source"],
  ): ArtifactMeta {
    return {
      url: artifactUrl(ref),
      folder: ref.folder,
      filename: ref.filename,
      size,
      mimeType: detectMime(ref.filename),
      encoding,
      updatedAt,
      source,
    };
  }

  /** The sidecar is the ledger for one artifact. A missing or torn sidecar is
   *  normal (artifacts predate it): callers treat `{}` as "nothing recorded". */
  type Sidecar = {
    encoding?: "utf8" | "base64";
    source?: ArtifactUploadInput["source"];
    sha256?: string;
  };
  function readSidecar(p: string): Sidecar {
    try {
      return JSON.parse(readFileSync(`${p}.meta.json`, "utf8")) as Sidecar;
    } catch {
      return {};
    }
  }

  return {
    async put(input) {
      const [folder, filename] = splitPath(`${input.folder}/${input.filename}`);
      const p = safePath(folder, filename);
      mkdirSync(join(rootResolved, folder), { recursive: true });
      const enc = input.encoding === "base64" ? "base64" : "utf8";
      // Decode once: the ledger must cover exactly the bytes that land on disk
      // (for base64 that is the decoded payload, never the base64 text).
      const buf = Buffer.from(input.content, enc);
      writeFileSync(p, buf);
      const updatedAt = Date.now();
      const sha256 = createHash("sha256").update(buf).digest("hex");
      writeFileSync(
        `${p}.meta.json`,
        JSON.stringify({
          encoding: enc,
          source: input.source ?? null,
          updatedAt,
          sha256,
        }),
      );
      return { ...toMeta({ folder, filename }, buf.length, enc, updatedAt, input.source), sha256 };
    },
    async get(ref) {
      const p = safePath(ref.folder, ref.filename);
      try {
        const buf = readFileSync(p);
        const sidecar = readSidecar(p);
        const encoding: "utf8" | "base64" =
          sidecar.encoding === "base64"
            ? "base64"
            : sidecar.encoding === undefined && !isTextBuf(buf)
              ? "base64"
              : "utf8";
        return {
          ...toMeta(ref, buf.length, encoding, statSync(p).mtimeMs, undefined),
          ...(sidecar.sha256 ? { sha256: sidecar.sha256 } : {}),
          content: encoding === "utf8" ? buf.toString("utf8") : buf.toString("base64"),
        };
      } catch {
        return null;
      }
    },
    async list(folder) {
      // Reject BEFORE any filesystem access: a folder resolving outside the
      // root must never reach existsSync/walk (M13 — the old guard only
      // existence-checked in-root paths, letting escaped dirs be walked).
      const base = resolve(rootResolved, folder ?? "");
      if (base !== rootResolved && !base.startsWith(rootResolved + sep)) {
        throw new Error("artifact path escapes root");
      }
      if (!existsSyncSafe(base)) return [];
      const out: ArtifactMeta[] = [];
      const walk = (d: string, prefix: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (entry.name.endsWith(".meta.json")) continue;
          const full = join(d, entry.name);
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(full, rel);
          else {
            const st = statSync(full);
            const [f, fn] = splitPath(rel);
            // One sidecar read feeds provenance, encoding and the ledger.
            // Reporting a hard-coded "utf8" described binary artifacts wrong,
            // and the recorded hash is what a consumer verifies against.
            const sidecar = readSidecar(full);
            out.push({
              ...toMeta(
                { folder: f, filename: fn },
                st.size,
                sidecar.encoding === "base64" ? "base64" : "utf8",
                st.mtimeMs,
                sidecar.source ?? undefined,
              ),
              ...(sidecar.sha256 ? { sha256: sidecar.sha256 } : {}),
            });
          }
        }
      };
      walk(base, folder ?? "");
      return out;
    },
    async delete(url) {
      const ref = parseArtifactUrl(url);
      const p = safePath(ref.folder, ref.filename);
      try {
        rmSync(p, { force: true });
        // The sidecar belongs to the artifact: leaving it behind piles up
        // invisible junk (the listing skips *.meta.json) and a re-upload of
        // the same name would inherit a stale ledger entry.
        rmSync(`${p}.meta.json`, { force: true });
        return true;
      } catch {
        return false;
      }
    },
    async exists(url) {
      const ref = parseArtifactUrl(url);
      const p = safePath(ref.folder, ref.filename);
      return existsSyncSafe(p);
    },
    async verify(url) {
      const ref = parseArtifactUrl(url);
      const p = safePath(ref.folder, ref.filename);
      if (!existsSyncSafe(p)) return null;
      const actual = createHash("sha256").update(readFileSync(p)).digest("hex");
      const expected = readSidecar(p).sha256;
      // No ledger entry ⇒ not a pass: "unrecorded" must not read as "intact".
      return { ok: expected === actual, expected, actual };
    },
  };
}

function existsSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isTextBuf(buf: Buffer): boolean {
  // Heuristic: no null bytes in the first 8KB → treat as UTF-8 text.
  const sample = buf.subarray(0, 8192);
  return !sample.includes(0);
}
