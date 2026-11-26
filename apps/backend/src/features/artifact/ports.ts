import type {
  ArtifactListFilter,
  ArtifactMeta,
  ArtifactRef,
  ArtifactUploadInput,
  ArtifactVerification,
} from "./domain.js";

export interface ArtifactPort {
  put(input: ArtifactUploadInput): Promise<ArtifactMeta>;
  get(ref: ArtifactRef): Promise<(ArtifactMeta & { content: string }) | null>;
  list(filter?: string | ArtifactListFilter): Promise<ArtifactMeta[]>;
  /** Single-artifact metadata lookup without reading file bytes (ADR 0082 D8). */
  getMeta?(url: string): Promise<ArtifactMeta | null>;
  delete(url: string): Promise<boolean>;
  exists(url: string): Promise<boolean>;
  /** Re-read the file and compare it with its ledger entry. Null when the
   *  artifact does not exist. */
  verify(url: string): Promise<ArtifactVerification | null>;
  /** Idempotent startup sync from disk into the SQLite index (ADR 0082 D1). */
  backfill?(): Promise<number>;
}
