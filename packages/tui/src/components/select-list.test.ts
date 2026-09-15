import { describe, expect, test } from "bun:test";
import { type SelectItem, SelectList, type SelectListTheme } from "./select-list.ts";

const theme: SelectListTheme = {
  selectedPrefix: (t) => t,
  selectedText: (t) => t,
  description: (t) => t,
  scrollInfo: (t) => t,
  noMatch: (t) => t,
};

const items = (): SelectItem[] => [
  { value: "a", label: "09-15 10:00", description: "first" },
  { value: "b", label: "09-15 09:00", description: "second" },
  { value: "c", label: "09-15 08:00", description: "third" },
];

/** Ctrl+D is the picker's delete chord (EOT in legacy terminals, CSI-u under
 *  the Kitty protocol). The list only REPORTS the deletion — the owner
 *  removes the item and calls setItems, so the collection never mutates
 *  behind the owner's back. */
describe("SelectList delete", () => {
  test("ctrl+d reports the selected item", () => {
    const list = new SelectList(items(), 10, theme);
    const deleted: string[] = [];
    list.onDelete = (item) => deleted.push(item.value);
    list.handleInput("\u0004");
    expect(deleted).toEqual(["a"]);
  });

  test("the delete chord only fires when a handler is attached", () => {
    const list = new SelectList(items(), 10, theme);
    // No throw and no selection change: an unhandled chord is a no-op.
    expect(() => list.handleInput("\u0004")).not.toThrow();
  });

  test("setItems replaces the collection and clamps the selection", () => {
    const list = new SelectList(items(), 10, theme);
    list.handleInput("\u001b[B"); // down -> "b"
    list.handleInput("\u001b[B"); // down -> "c" (last)
    list.setItems([
      { value: "a", label: "09-15 10:00", description: "first" },
      { value: "b", label: "09-15 09:00", description: "second" },
    ]);
    const seen: string[] = [];
    list.onDelete = (item) => seen.push(item.value);
    // Selection was on "c" (index 2); after the shrink it must resolve to the
    // new last row rather than pointing past the end.
    list.handleInput("\u0004");
    expect(seen).toEqual(["b"]);
  });

  test("an emptied list renders without throwing", () => {
    const list = new SelectList(items(), 10, theme);
    list.setItems([]);
    expect(() => list.render(40)).not.toThrow();
    expect(() => list.handleInput("\u0004")).not.toThrow();
  });
});
