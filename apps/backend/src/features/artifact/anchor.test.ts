import { describe, expect, test } from "bun:test";
import { type ArtifactAnchor, describeAnchor } from "./anchor.js";

describe("anchored comment rendering (raft: re: chip equivalent)", () => {
  test("a line anchor renders as file + line range", () => {
    const a: ArtifactAnchor = { kind: "lines", start: 42 };
    expect(describeAnchor("x.ts", a)).toBe("x.ts L42");
  });

  test("a line range collapses to start when start===end", () => {
    const a: ArtifactAnchor = { kind: "lines", start: 42, end: 45 };
    expect(describeAnchor("x.ts", a)).toBe("x.ts L42-45");
  });

  test("a named region keeps its label", () => {
    const a: ArtifactAnchor = { kind: "region", label: "checkout form" };
    expect(describeAnchor("page.html", a)).toBe("page.html (checkout form)");
  });

  test("a moment anchor renders as a timestamp", () => {
    const a: ArtifactAnchor = { kind: "moment", at: 95 };
    expect(describeAnchor("demo.mp4", a)).toBe("demo.mp4 @1:35");
  });

  test("a row anchor names the row range", () => {
    const a: ArtifactAnchor = { kind: "rows", start: 3, end: 7 };
    expect(describeAnchor("data.csv", a)).toBe("data.csv rows 3-7");
  });
});
