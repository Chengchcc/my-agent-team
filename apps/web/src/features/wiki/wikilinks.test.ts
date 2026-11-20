import { describe, expect, test } from "bun:test";
import { linkifyWikilinks, titleIndex } from "./wikilinks";

const index = titleIndex([
  { path: "concepts/retry.md", title: "Retry" },
  { path: "projects/login/a.md", title: "Login A" },
]);

describe("Obsidian-style wikilinks", () => {
  test("[[Title]] resolves by title to a page link", () => {
    expect(linkifyWikilinks("see [[Retry]] now", index)).toBe(
      "see [Retry](/wiki/page?path=concepts%2Fretry.md) now",
    );
  });

  test("[[path.md|label]] keeps the label", () => {
    expect(linkifyWikilinks("[[projects/login/a.md|the login page]]", index)).toBe(
      "[the login page](/wiki/page?path=projects%2Flogin%2Fa.md)",
    );
  });

  test("an unresolved [[Name]] goes to search, not to a 404", () => {
    expect(linkifyWikilinks("[[Brand New]]", index)).toBe("[Brand New](/wiki?text=Brand%20New)");
  });

  test("![[x]] is an embed chip, not a wiki link (the ! must not leak)", () => {
    const out = linkifyWikilinks("![[Retry]]", index);
    expect(out).toBe("[Retry ↗](/wiki/page?path=concepts%2Fretry.md)");
  });
});
