import { describe, expect, test } from "bun:test";
import { NAV_SECTIONS, SETTINGS_SECTIONS, settingsSearch } from "./settings-layout";

/** A stand-in for `t`: one field is translated, the rest stay as written. */
function text(label: string): string {
  if (label === "Interface language") return "\u754c\u9762\u8bed\u8a00";
  return label;
}

describe("the Settings section list", () => {
  test("every field id and section id is unique; the nav holds the unfolded sections in order", () => {
    const sections = SETTINGS_SECTIONS.map((section) => section.id);
    expect(new Set(sections).size).toBe(sections.length);
    const fields = SETTINGS_SECTIONS.flatMap((section) => section.fields.map((f) => f.id));
    expect(new Set(fields).size).toBe(fields.length);
    expect(NAV_SECTIONS.map((section) => section.id)).toEqual(["workspace", "models", "execution"]);
  });

  test("an empty search matches every field", () => {
    const all = settingsSearch("   ", text);
    expect(all).toHaveLength(7);
  });

  test("a search matches a title, a search word or the translated title, word by word", () => {
    expect(settingsSearch("password", text)).toEqual(["password"]);
    expect(settingsSearch("MODEL", text)).toEqual(["providers", "customKeys", "assessment"]);
    expect(settingsSearch("api key", text)).toEqual(["providers", "customKeys"]);
    expect(settingsSearch("\u8bed\u8a00", text)).toEqual(["language"]);
    expect(settingsSearch("password model", text)).toEqual([]);
  });
});
