/** Which of the editor's three panes exist at a viewport width. A pane that is not visible is
 *  not mounted: no conversation subscription, no canvas instance, no code editor stays alive
 *  behind a hidden panel. */

/** `wide` is the viewport from `xl` (1280px), `mid` from 1024px, `narrow` below that. The
 *  middle band starts at 1024 rather than at `md` because the console's navigation rail (256px
 *  expanded) stands beside the editor: below 1024 a 320px side panel would leave the canvas less
 *  than 448px (192px at 768, measured), so one pane at a time is the better trade. */
export type EditorWidth = "wide" | "mid" | "narrow";
export type SidePanel = "node" | "pa";
export type EditorPane = "canvas" | SidePanel;

/** Which side panels the person asked for. From `xl` both can be open at once. */
export interface OpenSides {
  node: boolean;
  pa: boolean;
}

/** Which panes are mounted. */
export interface VisiblePanes {
  canvas: boolean;
  node: boolean;
  pa: boolean;
}

export const EDITOR_BREAKPOINTS = { md: 1024, xl: 1280 } as const;

export function widthOf(viewportWidth: number): EditorWidth {
  if (viewportWidth >= EDITOR_BREAKPOINTS.xl) {
    return "wide";
  }
  if (viewportWidth >= EDITOR_BREAKPOINTS.md) {
    return "mid";
  }
  return "narrow";
}

/** The panes at a width. Below 1024 only the chosen pane stands. Between 1024 and `xl` the canvas
 *  keeps its room and one side panel is shown at a time, the node inspector when both are asked
 *  for. From `xl` every open panel has its own column beside the canvas. */
export function visiblePanes(
  width: EditorWidth,
  sides: OpenSides,
  chosen: EditorPane,
): VisiblePanes {
  if (width === "narrow") {
    return { canvas: chosen === "canvas", node: chosen === "node", pa: chosen === "pa" };
  }
  if (width === "mid") {
    let side: SidePanel | null = null;
    if (sides.node) {
      side = "node";
    } else if (sides.pa) {
      side = "pa";
    }
    return { canvas: true, node: side === "node", pa: side === "pa" };
  }
  return { canvas: true, node: sides.node, pa: sides.pa };
}

/** The toggle of one side panel. From `xl` each opens and closes on its own; between `md` and
 *  `xl` opening one closes the other, and the panel that is shown closes. There the switch goes
 *  by what is shown: a panel that is asked for but hidden behind the other still opens. */
export function toggleSide(width: EditorWidth, sides: OpenSides, side: SidePanel): OpenSides {
  if (width === "wide") {
    return { ...sides, [side]: !sides[side] };
  }
  const shown = visiblePanes("mid", sides, "canvas")[side];
  if (shown) {
    return { node: false, pa: false };
  }
  return { node: side === "node", pa: side === "pa" };
}

/** The narrow switch chose a pane. A side panel it chose is remembered as open, so it is still
 *  there when the window grows. */
export function choosePane(sides: OpenSides, pane: EditorPane): OpenSides {
  if (pane === "canvas") {
    return sides;
  }
  return { ...sides, [pane]: true };
}
