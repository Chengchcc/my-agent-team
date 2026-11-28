import { describe, expect, test } from "bun:test";
import { createModelRuntime } from "./model-runtime.js";
import type { Provider } from "./types.js";

function fakeProvider(id: string, modelIds: string[]): Provider {
  return {
    id,
    name: id,
    getModels: () =>
      modelIds.map((mid) => ({
        id: mid,
        name: mid,
        provider: id,
        api: "fake" as never,
        reasoning: false,
        input: ["text"] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
        baseUrl: undefined,
      })),
    async *stream() {
      yield { delta: { type: "text", text: "ok" } };
    },
  };
}

describe("ModelRuntime", () => {
  test("registers and retrieves providers", async () => {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider("test-p", ["m1"]));
    expect(rt.getProvider("test-p")).toBeTruthy();
  });

  test("rejects duplicate provider registration", () => {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider("dup", ["m1"]));
    expect(() => rt.registerProvider(fakeProvider("dup", ["m2"]))).toThrow();
  });

  test("setProvider replaces existing", async () => {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider("rep", ["m1"]));
    rt.setProvider(fakeProvider("rep", ["m2"]));
    const cat = await rt.refreshCatalog();
    expect(cat.models).toHaveLength(1);
    expect(cat.models[0]?.modelId).toBe("m2");
  });

  test("resolveModel finds model and returns credential", async () => {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider("p1", ["m1", "m2"]));
    const { model, credential } = await rt.resolveModel("p1", "m2");
    expect(model.modelId).toBe("m2");
    expect(model.providerId).toBe("p1");
    expect(credential).toEqual({});
  });

  test("resolveModel throws for unknown provider", async () => {
    const rt = createModelRuntime();
    expect(rt.resolveModel("nope", "m1")).rejects.toThrow();
  });

  test("refreshCatalog aggregates all providers", async () => {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider("p1", ["a", "b"]));
    rt.registerProvider(fakeProvider("p2", ["c"]));
    const cat = await rt.refreshCatalog();
    expect(cat.models).toHaveLength(3);
  });

  test("catalog is cached after refresh", async () => {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider("p1", ["x"]));
    const cat1 = await rt.getCatalog();
    const cat2 = await rt.getCatalog();
    expect(cat1.timestamp).toBe(cat2.timestamp);
  });

  test("resolveModel and stream fall back to MODEL_ALIASES when exact id is absent", async () => {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider("deepseek", ["deepseek-flash"]));
    const resolved = await rt.resolveModel("deepseek", "deepseek-chat");
    expect(resolved.model.modelId).toBe("deepseek-flash");
    const chunks = [];
    for await (const c of rt.stream("deepseek", "deepseek-chat", [{ role: "user", text: "hi" }])) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(1);
  });

  test("stream shallow-merges credential headers with opts.headers and ignores undefined overrides", async () => {
    let seenOpts: Record<string, unknown> | undefined;
    const base = fakeProvider("p1", ["m1"]);
    const spyProvider: Provider = {
      ...base,
      async *stream(_model, _messages, opts) {
        seenOpts = opts as Record<string, unknown>;
        yield { delta: { type: "text", text: "ok" } };
      },
    };
    const rt = createModelRuntime({
      credentialStore: {
        resolve: async () => ({
          apiKey: "cred-key",
          baseUrl: "https://cred.example/v1",
          headers: { "X-Tenant": "acme", "X-Override": "from-cred" },
        }),
      },
    });
    rt.registerProvider(spyProvider);
    for await (const _ of rt.stream("p1", "m1", [{ role: "user", text: "hi" }], {
      apiKey: undefined,
      headers: { "X-Override": "from-opts", "X-Trace": "123" },
    })) {
      void _;
    }
    expect(seenOpts?.apiKey).toBe("cred-key");
    expect(seenOpts?.baseUrl).toBe("https://cred.example/v1");
    expect(seenOpts?.headers).toEqual({
      "X-Tenant": "acme",
      "X-Override": "from-opts",
      "X-Trace": "123",
    });
  });
});
