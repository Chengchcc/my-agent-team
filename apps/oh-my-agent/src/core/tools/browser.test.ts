import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserTool, resolveChromeExecutable } from "./browser.js";

const tmp = mkdtempSync(join(tmpdir(), "oma-browser-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The integration tests below drive a REAL headless Chromium (data: URLs
 *  only, no network). CI runners ship one; a dev box may not — skip rather
 *  than fail, the same precedent as the bwrap/seatbelt suites. */
const HAS_CHROMIUM = (() => {
  try {
    return existsSync(resolveChromeExecutable());
  } catch {
    return false;
  }
})();

describe("resolveChromeExecutable", () => {
  test("PUPPETEER_EXECUTABLE_PATH wins", () => {
    const saved = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = "/opt/custom-chrome";
    try {
      expect(resolveChromeExecutable()).toBe("/opt/custom-chrome");
    } finally {
      if (saved === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
      else process.env.PUPPETEER_EXECUTABLE_PATH = saved;
    }
  });
});

/** action=open was a raw navigation primitive: web_fetch refused private hosts
 *  and non-http schemes while the browser happily opened them. The guard runs
 *  BEFORE getSharedBrowser(), so these need no Chromium. */
describe("browser tool refuses URLs its sibling web_fetch refuses", () => {
  test("a private host, a file:// path and a malformed URL are refused", async () => {
    const tool = createBrowserTool({ workspaceRoot: tmp });
    const loopback = await tool.execute({
      action: "open",
      name: "x",
      url: "http://127.0.0.1:3000/",
    });
    expect(loopback.isError).toBe(true);
    expect(String(loopback.content)).toContain("Blocked host");

    const lan = await tool.execute({ action: "open", name: "x", url: "http://192.168.1.5/admin" });
    expect(lan.isError).toBe(true);
    expect(String(lan.content)).toContain("Blocked host");

    const file = await tool.execute({ action: "open", name: "x", url: "file:///etc/passwd" });
    expect(file.isError).toBe(true);
    expect(String(file.content)).toContain("Blocked protocol");

    const bogus = await tool.execute({ action: "open", name: "x", url: "not a url" });
    expect(bogus.isError).toBe(true);
    expect(String(bogus.content)).toContain("invalid URL");
  });

  test("offline schemes stay allowed (data: is how the tool is driven offline)", async () => {
    const tool = createBrowserTool({ workspaceRoot: tmp });
    // No Chromium here: the guard passes, so the failure is the browser launch,
    // never a refusal.
    const res = await tool.execute({ action: "open", name: "x", url: "data:text/html,<p>hi</p>" });
    expect(String(res.content)).not.toContain("refused to open");
  });
});

describe("browser tool", () => {
  test("run requires an open tab; unknown action rejected", async () => {
    const tool = createBrowserTool({ workspaceRoot: tmp });
    const missing = await tool.execute({ action: "run", name: "nope", code: "return 1" });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("not open");
    const bad = await tool.execute({ action: "fly" });
    expect(bad.isError).toBe(true);
    const noCode = await tool.execute({ action: "run", name: "nope" });
    expect(noCode.isError).toBe(true);
  });
});

(HAS_CHROMIUM ? describe : describe.skip)("browser tool (requires chromium)", () => {
  test("open/run/close against a data: URL (real chromium, no network)", async () => {
    const tool = createBrowserTool({ workspaceRoot: tmp });
    const open = await tool.execute({
      action: "open",
      name: "t",
      url: "data:text/html,<title>T1</title><h1 id=h>hello</h1><button id=b>b</button>",
    });
    expect(open.isError).not.toBe(true);
    expect(open.content).toContain("T1");

    const run = await tool.execute({
      action: "run",
      name: "t",
      code: `
          const title = await tab.title();
          const text = await tab.evaluate(() => document.querySelector("#h")?.textContent);
          await tab.click("#b");
          await tab.screenshot({});
          return { title, text };
        `,
    });
    expect(run.isError).not.toBe(true);
    const withImages = run as { content: string; images?: Array<{ base64: string }> };
    expect(withImages.content).toContain("T1");
    expect(withImages.content).toContain("hello");
    expect(withImages.images).toHaveLength(1);
    // The screenshot landed in the workspace screenshots dir.
    const dir = join(tmp, ".oma", "screenshots");
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).some((f) => f.startsWith("t-"))).toBe(true);

    const close = await tool.execute({ action: "close", name: "t" });
    expect(close.content).toContain('Closed tab "t"');
    // Tab registry drained: a second close misses.
    const again = await tool.execute({ action: "close", name: "t" });
    expect(again.content).toContain("No tab");
  }, 90_000);

  test("run timeout kills the tab (recoverable)", async () => {
    const tool = createBrowserTool({ workspaceRoot: tmp });
    await tool.execute({ action: "open", name: "stuck", url: "data:text/html,<p>hi</p>" });
    const stuck = await tool.execute({
      action: "run",
      name: "stuck",
      timeout: 1,
      code: "await wait(30_000);",
    });
    expect(stuck.isError).toBe(true);
    expect(stuck.content).toContain("timed out");
    expect(stuck.content).toContain("killed");
    // The tab is gone from the registry (release ran).
    const gone = await tool.execute({ action: "run", name: "stuck", code: "return 1" });
    expect(gone.content).toContain("not open");
  }, 30_000);
});
