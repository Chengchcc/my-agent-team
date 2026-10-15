import { describe, expect, test } from "bun:test";
import { createEmbeddingClient, EmbeddingUnavailableError } from "./embedding.js";

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      url: String(url),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function ok(vectors: number[][], status = 200) {
  return new Response(JSON.stringify({ data: vectors.map((embedding) => ({ embedding })) }), {
    status,
  });
}

describe("embedding client", () => {
  test("posts an OpenAI-compatible embeddings request and returns vectors in order", async () => {
    const { impl, calls } = fakeFetch(() =>
      ok([
        [1, 0],
        [0, 1],
      ]),
    );
    const client = createEmbeddingClient({
      model: "ollama/paraphrase-multilingual",
      baseUrl: "http://127.0.0.1:11434/v1/",
      fetchImpl: impl,
    });

    expect(await client.embed(["a", "b"])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    // The trailing slash on the base is not doubled.
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/v1/embeddings");
    expect(calls[0]?.body).toEqual({
      model: "paraphrase-multilingual",
      input: ["a", "b"],
    });
  });

  test("resolves the key per call, so one added later needs no restart", async () => {
    const { impl, calls } = fakeFetch(() => ok([[1]]));
    const keys: { current?: string } = {};
    const client = createEmbeddingClient({
      model: "p/m",
      baseUrl: "http://x/v1",
      apiKey: () => keys.current,
      fetchImpl: impl,
    });

    await client.embed(["a"]);
    expect(calls[0]?.headers.authorization).toBeUndefined();
    keys.current = "k";
    await client.embed(["a"]);
    expect(calls[1]?.headers.authorization).toBe("Bearer k");
  });

  test("no inputs means no request", async () => {
    const { impl, calls } = fakeFetch(() => ok([]));
    const client = createEmbeddingClient({ model: "p/m", baseUrl: "http://x", fetchImpl: impl });

    expect(await client.embed([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("a malformed model id or a missing base URL fails loudly", () => {
    expect(() => createEmbeddingClient({ model: "justmodel" })).toThrow(EmbeddingUnavailableError);
    expect(() => createEmbeddingClient({ model: "p/m" })).toThrow(/BACKEND_EMBEDDING_BASE_URL/);
  });

  test("an HTTP error carries the status and body, so the index can say why", async () => {
    const { impl } = fakeFetch(
      () => new Response('{"error":{"code":"1113","message":"no balance"}}', { status: 429 }),
    );
    const client = createEmbeddingClient({ model: "p/m", baseUrl: "http://x", fetchImpl: impl });

    await expect(client.embed(["a"])).rejects.toThrow(/429.*1113/s);
  });

  test("a transport failure is reported as unavailable, not as an empty result", async () => {
    const impl = (() => Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;
    const client = createEmbeddingClient({ model: "p/m", baseUrl: "http://x", fetchImpl: impl });

    await expect(client.embed(["a"])).rejects.toThrow(/connection refused/);
  });

  test("ragged, short or empty vector sets are rejected", async () => {
    const short = fakeFetch(() => ok([[1, 2]]));
    const ragged = fakeFetch(() => ok([[1, 2], [1]]));
    const empty = fakeFetch(() => ok([[]]));

    await expect(
      createEmbeddingClient({ model: "p/m", baseUrl: "http://x", fetchImpl: short.impl }).embed([
        "a",
        "b",
      ]),
    ).rejects.toThrow(/1 vectors for 2 inputs/);
    await expect(
      createEmbeddingClient({ model: "p/m", baseUrl: "http://x", fetchImpl: ragged.impl }).embed([
        "a",
        "b",
      ]),
    ).rejects.toThrow(/ragged or empty/);
    await expect(
      createEmbeddingClient({ model: "p/m", baseUrl: "http://x", fetchImpl: empty.impl }).embed([
        "a",
      ]),
    ).rejects.toThrow(/ragged or empty/);
  });
});
