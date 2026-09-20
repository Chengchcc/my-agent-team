import { describe, expect, test } from "bun:test";
import { tuiTheme } from "../theme.ts";
import { type OutputBlockState, renderOutputBlock } from "./output-block.ts";

/** The border is the state's verdict channel: it must carry the SAME theme
 *  token the header icon/title use (running gold, error crimson, success
 *  jade), so the frame color answers "live / failed / done" at a glance —
 *  and a future theme swap recolors borders with everything else. */
describe("output block state border", () => {
  const top = (state: OutputBlockState): string =>
    renderOutputBlock({ state, sections: [], width: 12 })[0] ?? "";

  test("border color mirrors the verdict token per state", () => {
    expect(top("running")).toContain(tuiTheme.warning);
    expect(top("error")).toContain(tuiTheme.error);
    expect(top("success")).toContain(tuiTheme.success);
    expect(top("pending")).toContain(tuiTheme.info);
    expect(top("warning")).toContain(tuiTheme.warning);
  });

  /** The mapping this file replaced had running=blue and error=teal-blue —
   *  visually the same border for opposite verdicts, which is why the border
   *  carried no status signal at all. */
  test("running and error borders are distinguishable", () => {
    expect(top("running")).not.toBe(top("error"));
  });

  test("an explicit borderColor override still wins over the state default", () => {
    const lines = renderOutputBlock({
      state: "running",
      borderColor: tuiTheme.dim,
      sections: [],
      width: 12,
    });
    expect(lines[0]).toContain(tuiTheme.dim);
  });
});
