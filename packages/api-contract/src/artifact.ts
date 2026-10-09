import { z } from "zod";

/** `GET /api/artifacts/download` answer: the store's honest shape, bytes as
 *  base64 in a JSON envelope (that is what SQLite/fs hold), NOT a raw byte
 *  stream. A consumer that assumes raw bytes sends garbage downstream —
 *  verified live 2026-10-09: Feishu answered 234011 "Can't recognize image
 *  format" because the PNG arrived as the 504-byte JSON envelope. */
export const artifactContentSchema = z.object({
  content: z.string(),
  encoding: z.union([z.literal("utf8"), z.literal("base64")]),
  mimeType: z.string(),
  size: z.number(),
});
