import { HttpError } from "../../infra/errors.js";
import {
  type ArtifactContent,
  type ArtifactListFilter,
  type ArtifactMeta,
  type ArtifactRef,
  type ArtifactUploadInput,
  type ArtifactVerification,
  artifactUrl,
  parseArtifactUrl,
  splitPath,
} from "./domain.js";
import type { ArtifactPort } from "./ports.js";

export interface ArtifactService {
  upload(input: ArtifactUploadInput): Promise<ArtifactMeta>;
  download(url: string): Promise<ArtifactContent>;
  list(filter?: string | ArtifactListFilter): Promise<ArtifactMeta[]>;
  getMeta(url: string): Promise<ArtifactMeta | null>;
  delete(url: string): Promise<boolean>;
  exists(url: string): Promise<boolean>;
  verify(url: string): Promise<ArtifactVerification | null>;
  backfill(): Promise<number>;
  /** Delete artifacts older than `days`, sidecars included. 0 (or less) keeps
   *  everything: these are the user's own files, so age alone never deletes. */
  purgeOlderThan(days: number): Promise<number>;
}

export function createArtifactService(port: ArtifactPort): ArtifactService {
  return {
    async upload(input) {
      const [folder, filename] = splitPath(`${input.folder}/${input.filename}`);
      const ref: ArtifactRef = { folder, filename };
      return port.put({ ...input, folder: ref.folder, filename: ref.filename });
    },
    async download(url) {
      const ref = parseArtifactUrl(url);
      const rec = await port.get(ref);
      if (!rec) throw new HttpError(`artifact not found: ${url}`, 404);
      return {
        content: rec.content,
        encoding: rec.encoding,
        mimeType: rec.mimeType,
        size: rec.size,
      };
    },
    async list(filter) {
      return port.list(filter);
    },
    async getMeta(url) {
      parseArtifactUrl(url);
      if (port.getMeta) return port.getMeta(url);
      const all = await port.list();
      return all.find((a) => a.url === url) ?? null;
    },
    async delete(url) {
      return port.delete(url);
    },
    async exists(url) {
      return port.exists(url);
    },
    async verify(url) {
      return port.verify(url);
    },
    async backfill() {
      return (await port.backfill?.()) ?? 0;
    },
    async purgeOlderThan(days) {
      if (!(days > 0)) return 0;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      let removed = 0;
      for (const meta of await port.list()) {
        if (meta.updatedAt >= cutoff) continue;
        if (await port.delete(meta.url)) removed += 1;
      }
      return removed;
    },
  };
}

export { artifactUrl };
