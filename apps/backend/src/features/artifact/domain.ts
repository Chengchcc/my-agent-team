import { HttpError } from "../../infra/errors.js";
/** Artifact domain model: single-file artifacts addressed by
 *  `artifacts://<folder>/<filename>` URLs, stored under backend dataDir. */

export interface ArtifactRef {
  folder: string;
  filename: string;
}

export interface ArtifactUploadInput {
  folder: string;
  filename: string;
  content: string;
  /** utf8 = text; base64 = binary. Default utf8. */
  encoding?: "utf8" | "base64";
  /** Optional run provenance (audit only; download is globally available). */
  source?: { runId?: string; conversationId?: string; agentId?: string };
}

export interface ArtifactMeta {
  url: string;
  folder: string;
  filename: string;
  size: number;
  mimeType: string;
  encoding: "utf8" | "base64";
  updatedAt: number;
  source?: ArtifactUploadInput["source"];
}

export interface ArtifactContent {
  content: string;
  encoding: "utf8" | "base64";
  mimeType: string;
  size: number;
}

/** Parse `artifacts://<folder>/<filename>` into a safe ref. Throws on
 *  malformed URLs / path escapes. */
export function parseArtifactUrl(url: string): ArtifactRef {
  const m = /^artifacts:\/\/([^?]+)$/.exec(url.trim());
  if (!m) throw new HttpError(`invalid artifact URL: ${url}`, 400);
  const [folder, filename] = splitPath(m[1]!);
  return { folder, filename };
}

/** Split a `folder/filename` path, rejecting `../` / absolute / drive prefixes. */
export function splitPath(path: string): [string, string] {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new HttpError(`unsafe artifact path: ${path}`, 400);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`artifact path must be folder/filename: ${path}`);
  const filename = parts.pop()!;
  const folder = parts.join("/");
  for (const p of parts) {
    if (p === ".." || p === "." || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
      throw new HttpError(`unsafe artifact folder segment: ${p}`, 400);
    }
  }
  if (filename === ".." || filename === "." || filename.includes("/") || filename === "*") {
    throw new HttpError(`unsafe artifact filename: ${filename}`, 400);
  }
  return [folder, filename];
}

export function artifactUrl(ref: ArtifactRef): string {
  return `artifacts://${ref.folder}/${ref.filename}`;
}
