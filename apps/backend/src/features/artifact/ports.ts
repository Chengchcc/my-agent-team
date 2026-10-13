import type {
  ArtifactMeta,
  ArtifactRef,
  ArtifactUploadInput,
  ArtifactVerification,
} from "./domain.js";

export interface ArtifactPort {
  put(input: ArtifactUploadInput): Promise<ArtifactMeta>;
  get(ref: ArtifactRef): Promise<(ArtifactMeta & { content: string }) | null>;
  list(folder?: string): Promise<ArtifactMeta[]>;
  delete(url: string): Promise<boolean>;
  exists(url: string): Promise<boolean>;
  /** Re-read the file and compare it with its ledger entry. Null when the
   *  artifact does not exist. */
  verify(url: string): Promise<ArtifactVerification | null>;
}
