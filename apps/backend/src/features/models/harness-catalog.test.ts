import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createHarnessCatalog } from "./harness-catalog.js";
import { harnessRoutes } from "./http.js";

const harnesses = () => [
  { key: "oma", name: "oma (native ACP server)" },
  { key: "pi", name: "pi (pi-acp bridge)" },
];

describe("createHarnessCatalog", () => {
  test("caches per harness and shares one probe between concurrent callers", async () => {
    let calls = 0;
    let clock = 1_000;
    const catalog = createHarnessCatalog({
      harnesses,
      probe: async (key) => {
        calls += 1;
        return {
          models: [{ value: `${key}/m`, name: `${key}/m` }],
          currentModel: `${key}/m`,
        };
      },
      ttlMs: 100,
      now: () => clock,
    });

    const [first, second] = await Promise.all([catalog.list(), catalog.list()]);
    // One probe per harness, not one per caller: a picker that mounts twice
    // must not spawn two bridges.
    expect(calls).toBe(2);
    expect(first).toEqual(second);

    await catalog.list();
    expect(calls).toBe(2);

    clock += 100;
    await catalog.list();
    expect(calls).toBe(4);
  });

  test("one harness failing does not blank the others", async () => {
    const catalog = createHarnessCatalog({
      harnesses,
      probe: async (key) => {
        if (key === "pi") throw new Error("bridge not installed");
        return { models: [{ value: "oma/m", name: "oma/m" }], currentModel: "oma/m" };
      },
    });

    const list = await catalog.list();
    expect(list.find((h) => h.key === "oma")?.models).toHaveLength(1);
    const pi = list.find((h) => h.key === "pi");
    expect(pi?.models).toEqual([]);
    expect(pi?.error).toContain("bridge not installed");
  });
});

describe("GET /api/harnesses", () => {
  test("returns every harness with the models it declares", async () => {
    const app = new Elysia().use(
      harnessRoutes(
        createHarnessCatalog({
          harnesses,
          probe: async () => ({ models: [{ value: "x/y", name: "x/y" }], currentModel: "x/y" }),
        }),
      ),
    );

    const res = await app.handle(new Request("http://localhost/api/harnesses"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      harnesses: Array<{ key: string; models: unknown[]; error: string | null }>;
    };
    expect(body.harnesses.map((h) => h.key)).toEqual(["oma", "pi"]);
    expect(body.harnesses[0]?.models).toHaveLength(1);
    expect(body.harnesses[0]?.error).toBeNull();
  });
});
