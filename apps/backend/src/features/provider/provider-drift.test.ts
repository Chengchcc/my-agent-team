import { describe, expect, test } from "bun:test";
import { BUILTIN_CATALOG } from "@chengchenccc/ai";
import { KNOWN_PROVIDERS } from "./service.js";

/** Transport variants that are not separate products: they share the same
 *  credentials as their base provider, so the UI must not list them twice. */
const API_VARIANTS = new Set(["openaiResponses"]);

describe("the provider list and the model catalogue agree", () => {
  const catalog = BUILTIN_CATALOG.providers;
  const catalogIds = Object.keys(catalog).filter((id) => !API_VARIANTS.has(id));
  const listed = KNOWN_PROVIDERS.map((p) => p.id);

  test("every catalogue provider is configurable in the UI", () => {
    // This is the gap the Z.AI work walked into: the catalogue gained `zai`,
    // the model picker listed its models, and the provider row — the thing
    // that makes a key appear configured — silently did not exist.
    expect(catalogIds.filter((id) => !listed.includes(id))).toEqual([]);
  });

  test("no provider is listed that the catalogue cannot serve", () => {
    expect(listed.filter((id) => !catalogIds.includes(id))).toEqual([]);
  });

  test("both lists read the same environment variable for a key", () => {
    for (const def of KNOWN_PROVIDERS) {
      const entry = catalog[def.id];
      if (!entry) continue;
      expect(def.apiKeyEnv).toBe(entry.apiKeyEnv);
    }
  });
});
