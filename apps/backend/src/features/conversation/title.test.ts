import { describe, expect, test } from "bun:test";
import { deriveConversationTitle } from "./title.js";

describe("product-owned conversation titles", () => {
  test("a plain first message is the title", () => {
    expect(deriveConversationTitle("Fix the Lark card buttons")).toBe("Fix the Lark card buttons");
  });

  test("whitespace collapses so the sidebar never gets a multi-line title", () => {
    expect(deriveConversationTitle("  why does\n\nthis   break?\t")).toBe("why does this break?");
  });

  test("a long turn is cut at a word boundary with an ellipsis", () => {
    const title = deriveConversationTitle(
      "Please investigate why the workflow execution keeps failing after the second node completes successfully",
    );
    expect(title).not.toBeNull();
    expect(title!.endsWith("…")).toBe(true);
    // Never mid-word: the character before the ellipsis is not inside a word.
    const body = title!.slice(0, -1);
    expect(body.length).toBeLessThanOrEqual(60);
    expect(
      "Please investigate why the workflow execution keeps failing after the second node"
        .startsWith(body),
    ).toBe(true);
  });

  test("an anchored comment's jump prefix is not the title", () => {
    // describeAnchor's vocabulary: lines, rows, region, moment.
    expect(deriveConversationTitle("[report.md L40-45] this range misreads the data")).toBe(
      "this range misreads the data",
    );
    expect(deriveConversationTitle("[data.csv rows 3-7] wrong totals")).toBe("wrong totals");
    expect(deriveConversationTitle("[page.html (checkout form)] the button is dead")).toBe(
      "the button is dead",
    );
    expect(deriveConversationTitle("[demo.mp4 @1:35] the cursor jumps")).toBe("the cursor jumps");
  });

  test("a bracket that is not an anchor keeps its own words", () => {
    expect(deriveConversationTitle("[URGENT] the deploy is broken")).toBe(
      "[URGENT] the deploy is broken",
    );
  });

  test("a delivered reminder titles by the reminder, not by the banner", () => {
    expect(deriveConversationTitle("⏰ Reminder (set earlier): review the release notes")).toBe(
      "review the release notes",
    );
  });

  test("nothing usable yields no title at all", () => {
    expect(deriveConversationTitle("")).toBeNull();
    expect(deriveConversationTitle("   \n  ")).toBeNull();
    expect(deriveConversationTitle(undefined)).toBeNull();
    // A bare prefix leaves nothing behind either.
    expect(deriveConversationTitle("[a.ts L1-2] ")).toBeNull();
  });
});
