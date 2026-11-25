import { describe, expect, test } from "bun:test";
import { choosePane, type OpenSides, toggleSide, visiblePanes, widthOf } from "./editor-layout";

const BOTH: OpenSides = { node: true, pa: true };
const NONE: OpenSides = { node: false, pa: false };
const PA_ONLY: OpenSides = { node: false, pa: true };

describe("widthOf", () => {
  test("the breakpoints are inclusive: 1280 is wide, 1024 is mid", () => {
    expect(widthOf(1280)).toBe("wide");
    expect(widthOf(1279)).toBe("mid");
    expect(widthOf(1024)).toBe("mid");
    // 768–1023 with the 256px rail beside a 320px panel leaves the canvas under 448px: one pane.
    expect(widthOf(1023)).toBe("narrow");
    expect(widthOf(768)).toBe("narrow");
  });
});

describe("visiblePanes", () => {
  test("from xl the canvas always stands and each open panel has its column", () => {
    expect(visiblePanes("wide", BOTH, "canvas")).toEqual({
      canvas: true,
      node: true,
      pa: true,
    });
    expect(visiblePanes("wide", NONE, "pa")).toEqual({
      canvas: true,
      node: false,
      pa: false,
    });
  });

  test("between md and xl the canvas keeps one side panel, the node inspector when both are asked for", () => {
    expect(visiblePanes("mid", BOTH, "canvas")).toEqual({
      canvas: true,
      node: true,
      pa: false,
    });
    expect(visiblePanes("mid", PA_ONLY, "node")).toEqual({
      canvas: true,
      node: false,
      pa: true,
    });
    expect(visiblePanes("mid", NONE, "node")).toEqual({
      canvas: true,
      node: false,
      pa: false,
    });
  });

  test("below md only the chosen pane is mounted, whatever is open", () => {
    expect(visiblePanes("narrow", BOTH, "canvas")).toEqual({
      canvas: true,
      node: false,
      pa: false,
    });
    expect(visiblePanes("narrow", BOTH, "pa")).toEqual({
      canvas: false,
      node: false,
      pa: true,
    });
    expect(visiblePanes("narrow", NONE, "node")).toEqual({
      canvas: false,
      node: true,
      pa: false,
    });
  });
});

describe("toggleSide", () => {
  test("from xl each panel opens and closes on its own", () => {
    expect(toggleSide("wide", BOTH, "node")).toEqual({ node: false, pa: true });
    expect(toggleSide("wide", NONE, "pa")).toEqual({ node: false, pa: true });
  });

  test("between md and xl opening one closes the other, and the shown one closes", () => {
    expect(toggleSide("mid", PA_ONLY, "node")).toEqual({ node: true, pa: false });
    expect(toggleSide("mid", PA_ONLY, "pa")).toEqual({ node: false, pa: false });
    expect(toggleSide("mid", NONE, "node")).toEqual({ node: true, pa: false });
    // Both are asked for and only the node inspector is shown: the PA switch opens the PA panel.
    expect(toggleSide("mid", BOTH, "pa")).toEqual({ node: false, pa: true });
    expect(toggleSide("mid", BOTH, "node")).toEqual({ node: false, pa: false });
  });
});

describe("choosePane", () => {
  test("remembers the side panel the narrow switch chose; the canvas changes nothing", () => {
    expect(choosePane(NONE, "pa")).toEqual({ node: false, pa: true });
    expect(choosePane(NONE, "node")).toEqual({ node: true, pa: false });
    expect(choosePane(BOTH, "canvas")).toEqual(BOTH);
  });
});
