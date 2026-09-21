import { describe, expect, test } from "bun:test";
import { SETTING_ROWS, SettingsOverlay } from "./settings-overlay.js";

/** `/settings` is the documented way to configure a standalone workspace, so a
 *  knob the runtime honors but the overlay cannot reach is effectively
 *  invisible — the reader has to know the JSON key to use it. */
describe("settings overlay rows", () => {
  test("every row is a real ProjectSettings key with a supported kind", () => {
    const kinds = new Set(["boolean", "number", "string", "enum"]);
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

  test("the build loop is reachable: loopAction is a row over its legal values", () => {
    // Nothing else names this setting — no command, no doc — so if the row
    // disappears the feature becomes invisible again.
    const row = SETTING_ROWS.find((r) => r.key === "loopAction");
    expect(row?.kind).toBe("enum");
    if (row?.kind !== "enum") return;
    expect(row.options).toContain("ralph");
    // The overlay must offer exactly what the parser accepts, or it will write
    // a value the loader silently drops.
    const overlay = new SettingsOverlay({}, () => {});
    // Drive the same code path the SelectList callback uses.
    const select = overlay as unknown as { handleSelect: (r: unknown) => void };
    const seen: string[] = [];
    for (let i = 0; i <= row.options.length; i++) {
      seen.push(String(overlay.getSettings().loopAction ?? "(unset)"));
      select.handleSelect(row);
    }
    // Unset starts at the documented default, then one cycle, then wraps.
    expect(seen).toEqual(["(unset)", "prompt", "compact", "reset", "ralph"]);
    expect(overlay.getSettings().loopAction).toBe("prompt");
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
