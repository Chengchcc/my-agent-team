import { describe, expect, test } from "bun:test";
import { createModelCatalogCheck } from "./model-check.js";

function registryWith(
  list: () => Promise<{ models: ReadonlyArray<{ id: string }> }>,
): Record<string, { catalog: { list: typeof list } }> {
  return { oma: { catalog: { list } } };
}

describe("createModelCatalogCheck", () => {
  test("accepts a model the kind's catalog lists", async () => {
    const check = createModelCatalogCheck({
      backends: registryWith(async () => ({ models: [{ id: "anthropic/claude" }] })),
    });
    expect(await check("oma", "anthropic", "claude")).toBe(true);
  });

  test("rejects a model the kind's catalog doesn't know", async () => {
    const check = createModelCatalogCheck({
      backends: registryWith(async () => ({ models: [{ id: "anthropic/claude" }] })),
    });
    expect(await check("oma", "zai", "glm-9")).toBe(false);
  });

  test("accepts an aliased legacy id that resolves into the catalog", async () => {
    const check = createModelCatalogCheck({
      backends: registryWith(async () => ({ models: [{ id: "deepseek/deepseek-flash" }] })),
    });
    expect(await check("oma", "deepseek", "deepseek-chat")).toBe(true);
  });

  test("unknown backend kind accepts (the API schema owns that gate)", async () => {
    const check = createModelCatalogCheck({ backends: {} });
    expect(await check("who", "a", "b")).toBe(true);
  });

  test("a failing catalog degrades to accept", async () => {
    const check = createModelCatalogCheck({
      backends: registryWith(async () => {
        throw new Error("child process is down");
      }),
    });
    expect(await check("oma", "zai", "glm-9")).toBe(true);
  });
});
