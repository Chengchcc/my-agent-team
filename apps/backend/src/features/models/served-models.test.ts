import { describe, expect, test } from "bun:test";
import {
  applyServedAvailability,
  createProviderModelProbe,
  createServedModelKnowledge,
} from "./served-models.js";

/** Drain a `.then/.catch/.finally` refresh chain without timers. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("createServedModelKnowledge", () => {
  test("unknown provider answers null and probes once (single-flight)", async () => {
    let probes = 0;
    const gate = Promise.withResolvers<readonly string[]>();
    const knowledge = createServedModelKnowledge({
      probe: () => {
        probes++;
        return gate.promise;
      },
    });
    expect(knowledge.serves("p", "m1")).toBeNull();
    expect(knowledge.serves("p", "m1")).toBeNull();
    resolveGate(gate, ["m1"]);
    await flushMicrotasks();
    expect(probes).toBe(1);
    expect(knowledge.serves("p", "m1")).toBe(true);
  });

  test("failed probe stays unknown instead of 'serves nothing'", async () => {
    const knowledge = createServedModelKnowledge({
      probe: () => Promise.reject(new Error("provider down")),
    });
    expect(knowledge.serves("p", "m1")).toBeNull();
    await flushMicrotasks();
    expect(knowledge.serves("p", "m1")).toBeNull();
  });

  test("stale entry answers from cache while a refresh runs", async () => {
    let clock = 1_000;
    let probes = 0;
    const knowledge = createServedModelKnowledge({
      probe: () => {
        probes++;
        return Promise.resolve(["m1"]);
      },
      ttlMs: 100,
      now: () => clock,
    });
    expect(knowledge.serves("p", "m1")).toBeNull();
    await flushMicrotasks();
    expect(knowledge.serves("p", "m1")).toBe(true);
    clock = 1_200;
    expect(knowledge.serves("p", "m1")).toBe(true);
    await flushMicrotasks();
    expect(probes).toBe(2);
    expect(knowledge.serves("p", "m1")).toBe(true);
  });

  test("a genuinely empty served list marks models missing", async () => {
    const knowledge = createServedModelKnowledge({
      probe: () => Promise.resolve([]),
    });
    expect(knowledge.serves("p", "m1")).toBeNull();
    await flushMicrotasks();
    expect(knowledge.serves("p", "m1")).toBe(false);
  });
});

describe("applyServedAvailability", () => {
  test("discovery only takes models away, never adds", () => {
    expect(applyServedAvailability(false, true)).toBe(false);
    expect(applyServedAvailability(true, false)).toBe(false);
    expect(applyServedAvailability(undefined, false)).toBe(false);
    expect(applyServedAvailability(true, null)).toBe(true);
    expect(applyServedAvailability(undefined, null)).toBeUndefined();
    expect(applyServedAvailability(undefined, true)).toBeUndefined();
  });
});

describe("createProviderModelProbe", () => {
  const env = { DEEPSEEK_API_KEY: "k" };

  test("no key answers null without a request", async () => {
    let fetched = 0;
    const probe = createProviderModelProbe({
      env: {},
      fetchImpl: async () => {
        fetched++;
        return Response.json({ data: [] });
      },
    });
    expect(await probe("deepseek")).toBeNull();
    expect(fetched).toBe(0);
  });

  test("parses the ids a provider serves", async () => {
    const probe = createProviderModelProbe({
      env,
      fetchImpl: async () => Response.json({ data: [{ id: "deepseek-flash" }, { id: "x" }] }),
    });
    expect(await probe("deepseek")).toEqual(["deepseek-flash", "x"]);
  });

  test("unreachable provider answers null", async () => {
    const probe = createProviderModelProbe({
      env,
      fetchImpl: async () => {
        throw new Error("boom");
      },
    });
    expect(await probe("deepseek")).toBeNull();
  });

  test("unparseable payload answers null, not 'serves nothing'", async () => {
    const probe = createProviderModelProbe({
      env,
      fetchImpl: async () => Response.json({ models: "not-the-shape-we-parse" }),
    });
    expect(await probe("deepseek")).toBeNull();
  });

  test("provider ids we don't ship answer null", async () => {
    const probe = createProviderModelProbe({
      env,
      fetchImpl: async () => Response.json({ data: [{ id: "x" }] }),
    });
    expect(await probe("custom-from-models-yml")).toBeNull();
  });
});

/** Resolve without relying on `new Promise(...)` (ts-promise-with-resolvers). */
function resolveGate(
  gate: PromiseWithResolversReturn<readonly string[]>,
  ids: readonly string[],
): void {
  gate.resolve(ids);
}

type PromiseWithResolversReturn<T> = ReturnType<typeof Promise.withResolvers<T>>;
