import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { zhOwn } from "../zh";
import { channelsZh } from "./channels";
import { pageZh } from "./index";
import { observabilityZh } from "./observability";
import { requirementsZh } from "./requirements";
import { teamZh } from "./team";
import { wikiZh } from "./wiki";

/** Every page dictionary, by file name. A new page file must be listed here and in `index.ts`. */
const PAGE_DICTIONARIES: Record<string, Record<string, string>> = {
  "channels.ts": channelsZh,
  "observability.ts": observabilityZh,
  "requirements.ts": requirementsZh,
  "team.ts": teamZh,
  "wiki.ts": wikiZh,
};

const SOURCES: Record<string, Record<string, string>> = { "zh.ts": zhOwn, ...PAGE_DICTIONARIES };

/** Keys that two dictionaries translate differently. Which file wins would then depend on the
 *  spread order, and one page would silently reword another. */
function conflicts(): string[] {
  const seen = new Map<string, [string, string][]>();
  for (const [file, dict] of Object.entries(SOURCES)) {
    for (const [key, value] of Object.entries(dict)) {
      seen.set(key, [...(seen.get(key) ?? []), [file, value]]);
    }
  }
  const found: string[] = [];
  for (const [key, owners] of seen) {
    const wordings = new Set(owners.map(([, value]) => value));
    if (wordings.size > 1) {
      found.push(`"${key}": ${owners.map(([file, value]) => `${file}="${value}"`).join(" | ")}`);
    }
  }
  return found.sort();
}

describe("page dictionaries", () => {
  test("every page file is registered here", () => {
    const files = readdirSync(import.meta.dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "index.ts")
      .sort();
    expect(files).toEqual(Object.keys(PAGE_DICTIONARIES).sort());
  });

  test("every page dictionary is merged, word for word", () => {
    const missing: string[] = [];
    for (const [file, dict] of Object.entries(PAGE_DICTIONARIES)) {
      for (const [key, value] of Object.entries(dict)) {
        if (pageZh[key] !== value) missing.push(`${file}: "${key}"`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("one key has one wording, whatever the file", () => {
    expect(conflicts()).toEqual([]);
  });
});
