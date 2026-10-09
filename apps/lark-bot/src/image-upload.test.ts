import { describe, expect, test } from "bun:test";
import { imageBytesFromArtifact, replyImageToMessage, uploadLarkImage } from "./image-upload.js";
import type { TokenProvider } from "./lark-api.js";

const provider: TokenProvider = {
  getToken: async () => "t-1",
  invalidate: () => {},
  getBaseUrl: () => "https://open.feishu.cn",
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("artifact envelope → image bytes (#65 output direction)", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const envelope = {
    content: png.toString("base64"),
    encoding: "base64",
    mimeType: "image/png",
    size: png.byteLength,
  };

  test("a base64 image artifact decodes with its own media type", () => {
    // Regression: the live path once uploaded the JSON envelope itself, because
    // the download route does NOT stream raw bytes.
    const decoded = imageBytesFromArtifact(envelope);
    expect(decoded?.mediaType).toBe("image/png");
    expect(Buffer.compare(decoded?.bytes ?? Buffer.alloc(0), png)).toBe(0);
  });

  test("a text artifact, an empty one, and a shapeless answer decode to null", () => {
    expect(imageBytesFromArtifact({ ...envelope, encoding: "utf8" })).toBeNull();
    expect(imageBytesFromArtifact({ ...envelope, content: "" })).toBeNull();
    expect(imageBytesFromArtifact({ content: "x" })).toBeNull();
  });
});

describe("Feishu image upload (#65 output direction)", () => {
  test("a key in the answer is the key we send with", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = String(url);
      return json({ code: 0, data: { image_key: "img_v3_abc" } });
    }) as unknown as typeof fetch;
    const key = await uploadLarkImage(provider, {
      bytes: Buffer.from([1, 2, 3]),
      mediaType: "image/png",
      filename: "shot.png",
    });
    expect(key).toBe("img_v3_abc");
    expect(calledUrl).toBe("https://open.feishu.cn/open-apis/im/v1/images");
  });

  test("a 200 with no key, a refusal, and a transport error all read as no image", async () => {
    globalThis.fetch = (async () => json({ code: 0, data: {} })) as unknown as typeof fetch;
    expect(
      await uploadLarkImage(provider, {
        bytes: Buffer.from([1]),
        mediaType: "image/png",
        filename: "s.png",
      }),
    ).toBeNull();
    globalThis.fetch = (async () =>
      json({ code: 234001, msg: "no" }, 400)) as unknown as typeof fetch;
    expect(
      await uploadLarkImage(provider, {
        bytes: Buffer.from([1]),
        mediaType: "image/png",
        filename: "s.png",
      }),
    ).toBeNull();
    globalThis.fetch = (async () => {
      throw new Error("net down");
    }) as unknown as typeof fetch;
    expect(
      await uploadLarkImage(provider, {
        bytes: Buffer.from([1]),
        mediaType: "image/png",
        filename: "s.png",
      }),
    ).toBeNull();
  });
});

describe("Feishu image reply (#65 output direction)", () => {
  test("the reply carries the key and stays in the thread", async () => {
    let body: Record<string, unknown> = {};
    let calledUrl = "";
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calledUrl = String(url);
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return json({ code: 0, data: { message_id: "om_1", thread_id: "omt_1" } });
    }) as unknown as typeof fetch;
    const result = await replyImageToMessage(provider, {
      rootMessageId: "om_root",
      imageKey: "img_v3_abc",
      replyInThread: true,
    });
    expect(result).toEqual({ ok: true, messageId: "om_1", threadId: "omt_1" });
    expect(calledUrl).toBe("https://open.feishu.cn/open-apis/im/v1/messages/om_root/reply");
    expect(body.msg_type).toBe("image");
    expect(JSON.parse(String(body.content))).toEqual({ image_key: "img_v3_abc" });
    expect(body.reply_in_thread).toBe(true);
  });

  test("a refusal or a shapeless answer is a failure with a reason", async () => {
    globalThis.fetch = (async () =>
      json({ code: 230002, msg: "not found" })) as unknown as typeof fetch;
    const refused = await replyImageToMessage(provider, {
      rootMessageId: "om_root",
      imageKey: "k",
      replyInThread: false,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("230002");
    globalThis.fetch = (async () => json({ code: 0 })) as unknown as typeof fetch;
    const shapeless = await replyImageToMessage(provider, {
      rootMessageId: "om_root",
      imageKey: "k",
      replyInThread: false,
    });
    expect(shapeless.ok).toBe(false);
  });
});
