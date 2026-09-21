import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualTerminal } from "@chengchenccc/tui";
import { fakeModelRuntime, screen, typeAndSubmit } from "./modes/tui/tui-e2e.fixture.js";
import { createTerminalIo, runTuiSession } from "./modes/tui/tui-mode.js";

describe("goal dbg", () => {
  test("/goal basic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-gdbg-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-gdbg-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "bash", input: { description: "c", command: "echo probe-ok" } },
    ]);
    try {
      const vt = new VirtualTerminal(120, 40);
      const io = createTerminalIo(vt);
      const done = runTuiSession({ modelRuntime: fakeModelRuntime(), workspaceRoot: dir }, io);
      await vt.waitForRender();
      await typeAndSubmit(vt, "/goal make probe print probe-ok");
      await new Promise((r) => setTimeout(r, 1500));
      const s = screen(vt);
      console.log(`SCREEN>>>\n${s.split("\n").slice(-18).join("\n")}\n<<<`);
      await quitSoon(vt);
      await done;
      expect(true).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
});

async function quitSoon(vt: import("@chengchenccc/tui").VirtualTerminal): Promise<void> {
  await typeAndSubmit(vt, "/exit");
  await typeAndSubmit(vt, "/exit");
}
