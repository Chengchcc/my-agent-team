import { describe, expect, test } from "bun:test";
import { SETTING_ROWS, SettingsOverlay } from "./settings-overlay.js";

/** `/settings` is the documented way to configure a standalone workspace, so a
 *  knob the runtime honors but the overlay cannot reach is effectively
 *  invisible — the reader has to know the JSON key to use it. */
describe("settings overlay rows", () => {
  test("every row is a real ProjectSettings key with a supported kind", () => {
    const kinds = new Set(["boolean", "number", "string"]);
    for (const row of SETTING_ROWS) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(kinds.has(row.kind)).toBe(true);
    }
  });

  test("rows that gate a capability are present", () => {
    const keys = SETTING_ROWS.map((r) => r.key);
    // Both of these loosen or tighten a boundary; a user must be able to find
    // them without reading the source.
    expect(keys).toContain("bashSandbox");
    expect(keys).toContain("browserLocalNetwork");
    expect(SETTING_ROWS.find((r) => r.key === "browserLocalNetwork")?.kind).toBe("boolean");
  });

  /** The boolean path is what the new knob rides, so pin it: an unset value
   *  toggles ON, a set value flips, and the change lands in getSettings()
   *  (which is what the caller persists). */
  test("an unset boolean toggles on and a set one flips", () => {
    const overlay = new SettingsOverlay({}, () => {});
    const row = SETTING_ROWS.find((r) => r.key === "browserLocalNetwork")!;
    // Drive the same code path the SelectList callback uses.
    const select = overlay as unknown as { handleSelect: (r: unknown) => void };
    select.handleSelect(row);
    expect(overlay.getSettings().browserLocalNetwork).toBe(true);
    select.handleSelect(row);
    expect(overlay.getSettings().browserLocalNetwork).toBe(false);
  });
});
