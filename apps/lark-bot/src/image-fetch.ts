/** Fetch a Feishu image as a vision block payload (#65: the lark input path).
 *
 *  Feishu image messages carry only an `image_key`; the bytes come from
 *  `GET /im/v1/images/:key` with the same tenant token CardKit uses. Strict on
 *  media type (the protocol carries four) and size (base64 inflates by a third
 *  and vision payloads have ceilings): anything else reads as "no image", which
 *  the caller turns into a logged skip — never a run triggered on nothing. */
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

/** The image_key out of a receive event's content: the platform sends
 *  `{"image_key": "img_v2_..."}` (lark-cli may or may not pre-render it), so
 *  accept the JSON field or a bare key. */
export function larkImageKeyOf(content: string): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      const key = (parsed as { image_key?: unknown }).image_key;
      if (typeof key === "string" && key.length > 0) return key;
    }
  } catch {
    /* not JSON — fall through to the bare-key shape */
  }
  return /^img_[A-Za-z0-9_-]+$/.test(content.trim()) ? content.trim() : null;
}
