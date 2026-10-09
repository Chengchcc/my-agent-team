/** Fetch a Feishu image as a vision block payload (#65: the lark input path).
 *
 *  Feishu image messages carry only an `image_key`; the bytes come from
 *  `GET /im/v1/images/:key` with the same tenant token CardKit uses. Strict on
 *  media type (the protocol carries four) and size (base64 inflates by a third
 *  and vision payloads have ceilings): anything else reads as "no image", which
 *  the caller turns into a logged skip — never a run triggered on nothing. */
import { larkImageContentSchema } from "@chengchenccc/api-contract";
import type { TokenProvider } from "./lark-api.js";

export interface LarkImage {
  base64: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

const MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** ~6MB raw ≈ 8MB base64: above any vision-model ceiling we would want to pay for. */
const MAX_BYTES = 6 * 1024 * 1024;

export async function fetchLarkImage(
  provider: TokenProvider,
  imageKey: string,
): Promise<LarkImage | null> {
  let res: Response;
  try {
    const token = await provider.getToken();
    const base = provider.getBaseUrl();
    res = await fetch(`${base}/open-apis/im/v1/images/${encodeURIComponent(imageKey)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const mediaType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!MEDIA_TYPES.has(mediaType)) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;
  return { base64: bytes.toString("base64"), mediaType: mediaType as LarkImage["mediaType"] };
}

/** The image keys inside a receive event's content, in order, deduped.
 *
 *  Two real shapes reach this code: the platform's JSON
 *  `{"image_key": "img_v3_..."}` for a bare image message, and lark-cli's
 *  PRE-RENDERED markdown — `![Image](img_v3_...)` inline in the text of a
 *  rich-text (post) message, caption and all (verified live 2026-10-09: a
 *  captioned image arrives as one post message, not an image message). The
 *  scanner covers both plus a bare key; the JSON shape is parsed by the
 *  shared wire schema (the contracts audit rejects bare casts). */
export function larkImageKeysOf(content: string): string[] {
  const keys: string[] = [];
  const push = (key: string): void => {
    if (!keys.includes(key)) keys.push(key);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    raw = undefined;
  }
  const parsed = raw === undefined ? null : larkImageContentSchema.safeParse(raw);
  if (parsed?.success) {
    push(parsed.data.image_key);
    return keys;
  }
  for (const match of content.matchAll(/img_[A-Za-z0-9_-]+/g)) push(match[0]);
  return keys;
}

/** The text with the rendered image markers stripped: the model should read
 *  the caption, not a dead link to a key it cannot fetch. A payload that is
 *  nothing but the image (the JSON shape, or markdown with no other words)
 *  has no caption at all. */
export function stripImageMarkers(content: string): string {
  const stripped = content.replace(/!\[[^\]]*\]\(img_[A-Za-z0-9_-]+\)/g, "").trim();
  if (stripped.length === 0) return "";
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch {
    return stripped;
  }
  return larkImageContentSchema.safeParse(raw).success ? "" : stripped;
}
