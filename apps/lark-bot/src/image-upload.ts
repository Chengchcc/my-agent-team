/** Send a produced image into the topic (#65, output direction).
 *
 *  Feishu splits this in two calls: the bytes are UPLOADED first
 *  (`POST /open-apis/im/v1/images`, multipart, `image_type=message`) and the
 *  returned key is what a message then carries — there is no way to attach
 *  bytes to a message directly. Both calls ride the same tenant token CardKit
 *  already holds, exactly like the inbound `image-fetch.ts`.
 *
 *  A failure is `null`/`{ok:false}`, never a throw: the caller records it and
 *  lets the watcher's reconnect re-run delivery, which is the same bookkeeping
 *  the text path uses. */
import {
  artifactContentSchema,
  larkImageUploadSchema,
  larkMessageSendSchema,
} from "@chengchenccc/api-contract";
import type { TokenProvider } from "./lark-api.js";

/** The artifact store answers base64 in a JSON envelope; a text artifact is
 *  not an image, and neither is a malformed answer. `null` means "nothing to
 *  send", never "send these bytes anyway". */
export function imageBytesFromArtifact(
  envelope: unknown,
): { bytes: Buffer; mediaType: string } | null {
  const parsed = artifactContentSchema.safeParse(envelope);
  if (!parsed.success) return null;
  if (parsed.data.encoding !== "base64") return null;
  const bytes = Buffer.from(parsed.data.content, "base64");
  if (bytes.byteLength === 0) return null;
  return { bytes, mediaType: parsed.data.mimeType };
}

export interface ImageReplyResult {
  ok: boolean;
  messageId?: string;
  threadId?: string;
  error?: string;
}

/** Upload image bytes as a message image; `null` when Feishu refuses or answers
 *  a shape we do not understand (a 200 with no key would otherwise look like
 *  success and produce an unreferenceable message). */
export async function uploadLarkImage(
  provider: TokenProvider,
  input: { bytes: Buffer; mediaType: string; filename: string },
): Promise<string | null> {
  try {
    const token = await provider.getToken();
    const form = new FormData();
    form.set("image_type", "message");
    form.set(
      // Uint8Array view: `Buffer<ArrayBufferLike>` does not satisfy BlobPart's
      // ArrayBuffer-based typing even though the runtime takes it.
      "image",
      new Blob([new Uint8Array(input.bytes)], { type: input.mediaType }),
      input.filename,
    );
    const res = await fetch(`${provider.getBaseUrl()}/open-apis/im/v1/images`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    // Read as text first: a refused upload must be diagnosable from the log,
    // and a silent `null` is how a scope/permission problem hides (#74 lesson).
    const raw = await res.text();
    if (!res.ok) {
      console.error(`[lark-image] upload refused: http ${res.status} ${raw.slice(0, 200)}`);
      return null;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      console.error(`[lark-image] upload answered non-JSON: ${raw.slice(0, 200)}`);
      return null;
    }
    const parsed = larkImageUploadSchema.safeParse(body);
    if (!parsed.success) {
      console.error(`[lark-image] unexpected upload shape: ${raw.slice(0, 200)}`);
      return null;
    }
    if (parsed.data.code !== 0) {
      console.error(
        `[lark-image] upload rejected: code ${parsed.data.code} ${parsed.data.msg ?? ""}`,
      );
      return null;
    }
    return parsed.data.data?.image_key ?? null;
  } catch (err) {
    console.error("[lark-image] upload threw:", err);
    return null;
  }
}

/** Reply an uploaded image to a thread's root message. */
export async function replyImageToMessage(
  provider: TokenProvider,
  input: { rootMessageId: string; imageKey: string; replyInThread: boolean },
): Promise<ImageReplyResult> {
  try {
    const token = await provider.getToken();
    const res = await fetch(
      `${provider.getBaseUrl()}/open-apis/im/v1/messages/${encodeURIComponent(input.rootMessageId)}/reply`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          msg_type: "image",
          content: JSON.stringify({ image_key: input.imageKey }),
          ...(input.replyInThread ? { reply_in_thread: true } : {}),
        }),
      },
    );
    const raw = await res.text();
    if (!res.ok) {
      console.error(`[lark-image] reply refused: http ${res.status} ${raw.slice(0, 200)}`);
      return { ok: false, error: `http ${res.status}` };
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return { ok: false, error: "non-JSON reply answer" };
    }
    const parsed = larkMessageSendSchema.safeParse(body);
    if (!parsed.success || parsed.data.code !== 0) {
      console.error(`[lark-image] reply rejected: ${raw.slice(0, 200)}`);
      return { ok: false, error: parsed.success ? `code ${parsed.data.code}` : "unexpected shape" };
    }
    const data = parsed.data.data;
    if (!data) return { ok: false, error: "no message id" };
    return {
      ok: true,
      messageId: data.message_id,
      ...(data.thread_id ? { threadId: data.thread_id } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
