import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canLaunchChromium,
  checkNavigationAllowed,
  createBrowserTool,
  resolveChromeExecutable,
} from "./browser.js";

const tmp = mkdtempSync(join(tmpdir(), "oma-browser-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The integration tests below drive a REAL headless Chromium (data: URLs
 *  only, no network). Existence of the executable is NOT enough: on some
 *  boxes the cached Chrome for Testing exists but cannot start (seen on
 *  macOS/arm64) — gate on a bounded LAUNCH probe so a broken environment
 *  skips with signal instead of failing red (bwrap/seatbelt precedent). */
const HAS_CHROMIUM = (() => {
  try {
    return existsSync(resolveChromeExecutable());
  } catch {
    return false;
  }
})();
const CAN_LAUNCH = HAS_CHROMIUM && (await canLaunchChromium());

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

  /** The navigation policy as a unit: the matrix is decided without launching
   *  Chromium, so the assertions cannot flake on a slow launch.
   *
   *  Inspecting the app you are building is a real coding workflow, so the
   *  workspace can opt in to local targets. The opt-in lifts ONLY the
   *  loopback/RFC1918 refusal: cloud metadata is where instance credentials
   *  live, and it must stay unreachable or the allowance becomes a credential
   *  primitive. The scheme rule is policy-independent in both directions. */
  test("local opt-in allows a dev server but never cloud metadata", async () => {
    for (const url of [
      "http://127.0.0.1:3000/",
      "http://localhost:5173/app",
      "http://192.168.1.5:8080/",
      "http://10.0.0.7/",
    ]) {
      expect(await checkNavigationAllowed(url, true)).toBeNull();
    }
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://100.100.100.200/latest/meta-data/",
    ]) {
      expect(String(await checkNavigationAllowed(url, true))).toContain("metadata");
    }
    // file: is refused with or without the opt-in (the browser must not become
    // a way around the file tools' workspace sandbox).
    for (const allowLocal of [false, true]) {
      expect(String(await checkNavigationAllowed("file:///etc/passwd", allowLocal))).toContain(
        "Blocked protocol",
      );
    }
  });

  test("local opt-in refuses a DNS name that resolves into cloud metadata", async () => {
    const ALLOW_LOCAL = true;
    // nip.io-style: the hostname is public-looking, the answer is 169.254/16.
    const rebind = await checkNavigationAllowed(
      "http://169-254-169-254.nip.io/latest/meta-data/",
      ALLOW_LOCAL,
      async () => ["169.254.169.254"],
    );
    expect(String(rebind)).toContain("metadata");
    // The CGNAT spelling of the same primitive (Alibaba metadata).
    const cgnat = await checkNavigationAllowed(
      "http://meta.attacker.example/",
      ALLOW_LOCAL,
      async () => ["100.100.100.200"],
    );
    expect(String(cgnat)).toContain("metadata");
    // A public name with a public answer stays allowed, and an unresolvable
    // host is the browser's error to surface, not a refusal.
    expect(
      await checkNavigationAllowed("http://example.com/", ALLOW_LOCAL, async () => [
        "93.184.216.34",
      ]),
    ).toBeNull();
    expect(
      await checkNavigationAllowed("http://no-such.invalid/", ALLOW_LOCAL, async () => []),
    ).toBeNull();
  });

  test("the default policy refuses every local target", async () => {
    for (const url of ["http://127.0.0.1:3000/", "http://192.168.1.5/", "http://localhost/"]) {
      expect(String(await checkNavigationAllowed(url, false))).toContain("Blocked host");
    }
    // …and still allows a public http(s) page (no regression for the normal case).
    expect(await checkNavigationAllowed("https://example.com/docs", false)).toBeNull();
  });

  test("without the opt-in a dev-server URL is refused (default posture)", async () => {
    const tool = createBrowserTool({ workspaceRoot: tmp });
    const res = await tool.execute({ action: "open", name: "dev", url: "http://127.0.0.1:3000/" });
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain("Blocked host");
  });

  test("offline schemes stay allowed (data: is how the tool is driven offline)", async () => {
    const tool = createBrowserTool({ workspaceRoot: tmp });
    // No Chromium here: the guard passes, so the failure is the browser launch,
    // never a refusal.
    const res = await tool.execute({ action: "open", name: "x", url: "data:text/html,<p>hi</p>" });
    expect(String(res.content)).not.toContain("refused to open");
    // This one really launches Chromium; a loaded box must not fail it.
  }, 30_000);
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

(CAN_LAUNCH ? describe : describe.skip)("browser tool (requires a launchable chromium)", () => {
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
    const open = await tool.execute({
      action: "open",
      name: "stuck",
      url: "data:text/html,<p>hi</p>",
    });
    // The precondition is part of the contract: a failed launch must be a
    // LOUD failure here, never a vacuous pass through the timeout path.
    expect(open.isError).not.toBe(true);
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
