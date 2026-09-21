import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolExecuteResult } from "@chengchenccc/message";
import type { Browser, Page } from "puppeteer-core";
import {
  assertSafeUrlDeep,
  isMetadataHost,
  parseHttpUrl,
  resolveHostAddresses,
} from "./url-guard.js";

/** browser: open, reuse, close, and script headless Chromium tabs
 *  (oh-my-pi browser.md surface, ponytail cut): ONE shared headless browser
 *  per process, named tabs, and a `run` action executing JS against a
 *  `tab` helper API.
 *
 *  ponytail: in-process execution — no Bun worker isolation, no stealth
 *  patches, no relay/cmux/ARIA bundle. A synchronously-spinning `run` code
 *  block cannot be interrupted; the tool timeout closes the page, which is
 *  the escape hatch. Upgrade path: port omp's tab-worker when that bites. */

/** Async-function constructor for `run` bodies (same trust level as the
 *  eval tool: the model writes the code; it runs with process access). */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

interface TabEntry {
  readonly name: string;
  readonly page: Page;
}

/** Process-global tab registry (the bash/eval bg-job pattern): the TUI
 *  shares tabs across Runs in one process; the backend runs one Run per
 *  process, so semantics are unchanged there. */
const tabs = new Map<string, TabEntry>();
let sharedBrowser: Browser | null = null;
let launching: Promise<Browser> | null = null;

const DEFAULT_VIEWPORT = { width: 1365, height: 768 };
const MIN_TIMEOUT_S = 1;
const MAX_TIMEOUT_S = 300;
const DEFAULT_TIMEOUT_S = 30;
/** observe/extract output caps: the model, not the page, is the sink. */
const MAX_OBSERVE_BYTES = 12_000;
const MAX_EXTRACT_CHARS = 20_000;

/** Puppeteer cache layouts, newest version first. Chromium's cache directory
 *  name (and the binary inside it) is platform-specific. */
function chromeCacheCandidates(cacheDir: string): string[] {
  const layouts: ReadonlyArray<readonly [dir: string, binary: string]> =
    process.platform === "darwin"
      ? [
          [
            "chrome-mac-arm64",
            "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          ],
          [
            "chrome-mac-x64",
            "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          ],
          ["chrome-mac-arm64", "Chromium.app/Contents/MacOS/Chromium"],
          ["chrome-mac-x64", "Chromium.app/Contents/MacOS/Chromium"],
        ]
      : process.platform === "win32"
        ? [
            ["chrome-win64", "chrome.exe"],
            ["chrome-win32", "chrome.exe"],
          ]
        : [
            ["chrome-linux64", "chrome"],
            ["chrome-linux", "chrome"],
          ];
  let versions: string[];
  try {
    versions = readdirSync(cacheDir).sort().reverse();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const version of versions) {
    for (const [dir, binary] of layouts) out.push(join(cacheDir, version, dir, binary));
  }
  return out;
}

/** System-browser fallbacks: the well-known install locations for the
 *  platforms whose package managers do not guarantee a `which`-able name. */
const SYSTEM_BROWSER_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];

/** Resolve the Chromium executable: PUPPETEER_EXECUTABLE_PATH, then the
 *  puppeteer cache for this platform, then a system browser. Throws when
 *  nothing is installed — callers surface that as a tool error. */
export function resolveChromeExecutable(): string {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) return fromEnv;
  const fromCache = chromeCacheCandidates(join(homedir(), ".cache", "puppeteer", "chrome")).find(
    (p) => existsSync(p),
  );
  if (fromCache) return fromCache;
  const fromSystem = SYSTEM_BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (fromSystem) return fromSystem;
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = Bun.spawnSync(["which", bin], { stdout: "pipe", stderr: "ignore" });
    if (found.exitCode === 0) {
      const path = found.stdout.toString().trim();
      if (path) return path;
    }
  }
  throw new Error("no Chromium found — set PUPPETEER_EXECUTABLE_PATH or install Chrome/Chromium");
}

async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser?.connected) return sharedBrowser;
  if (launching) return launching;
  launching = (async () => {
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.launch({
      executablePath: resolveChromeExecutable(),
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
      defaultViewport: DEFAULT_VIEWPORT,
      protocolTimeout: 60_000,
    });
    sharedBrowser = browser;
    return browser;
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

/** Launchability probe (bounded): the executable EXISTING says nothing on
 *  boxes whose cached Chrome for Testing cannot start (seen on macOS/arm64).
 *  Integration tests gate on this instead of file existence, so a broken
 *  environment skips with signal rather than failing red — and a vacuous
 *  pass cannot hide behind a launch that never worked.
 *
 *  The probe launches its OWN browser and ALWAYS closes it: it must not touch
 *  the shared singleton, because a probe that times out leaves the shared
 *  launch promise in flight and the browser it eventually spawns would live
 *  for the rest of the process (test runs leaked one headless Chrome per
 *  invocation). */
export async function canLaunchChromium(boundMs = 8_000): Promise<boolean> {
  let browser: Browser | undefined;
  let timer: Timer | undefined;
  try {
    const puppeteer = await import("puppeteer-core");
    const launched = await Promise.race([
      puppeteer.launch({
        executablePath: resolveChromeExecutable(),
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
        defaultViewport: DEFAULT_VIEWPORT,
        protocolTimeout: 60_000,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timeout")), boundMs);
        timer.unref?.();
      }),
    ]);
    browser = launched;
    const page = await launched.newPage();
    await page.goto("data:text/html,<title>probe</title>");
    await page.close();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    // AWAIT the close: a fire-and-forget close races the test process exit and
    // the browser survives as an orphan (one leaked headless Chrome per run).
    await browser?.close().catch(() => {});
  }
}

/** Close the tool-owned shared browser and drain the tab registry.
 *  Production calls this indirectly (releasing the LAST tab closes it); the
 *  explicit entry point exists for test teardown, where a mid-test failure
 *  would otherwise leave a headless Chrome running for the rest of the
 *  process. */
export async function closeSharedBrowserForTests(): Promise<void> {
  for (const name of [...tabs.keys()]) await releaseTab(name);
  const browser = sharedBrowser;
  sharedBrowser = null;
  await browser?.close().catch(() => {});
}

/** Release one tab; when the last tab goes, the tool-owned headless browser
 *  closes with it. */
async function releaseTab(name: string): Promise<string> {
  const entry = tabs.get(name);
  if (!entry) return `No tab named "${name}".`;
  tabs.delete(name);
  await entry.page.close().catch(() => {});
  if (tabs.size === 0 && sharedBrowser) {
    const browser = sharedBrowser;
    sharedBrowser = null;
    await browser.close().catch(() => {});
  }
  return `Closed tab "${name}".`;
}

/** The per-tab helper API handed to `run` code. */
function createTabApi(name: string, page: Page, screenshotDir: string) {
  return {
    name,
    url: () => page.url(),
    title: () => page.title(),
    goto: (
      url: string,
      opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2" },
    ) => page.goto(url, { waitUntil: opts?.waitUntil ?? "load", timeout: 30_000 }),
    /** Accessibility-tree snapshot of the whole page (JSON, capped). */
    observe: async () => {
      const snap = await page.accessibility.snapshot();
      const text = JSON.stringify(snap, null, 1) ?? "";
      return text.length > MAX_OBSERVE_BYTES
        ? `${text.slice(0, MAX_OBSERVE_BYTES)}\n…(truncated — narrow with tab.evaluate)`
        : text;
    },
    /** Screenshot: saved under <workspace>/.oma/screenshots; returns the path
     *  (the run wrapper turns it into a vision image block unless silent). */
    screenshot: async (opts?: { fullPage?: boolean; silent?: boolean }) => {
      mkdirSync(screenshotDir, { recursive: true });
      const dest = join(screenshotDir, `${name}-${Date.now()}.png`);
      await page.screenshot({ fullPage: opts?.fullPage ?? false, path: dest });
      return dest;
    },
    /** Raw HTML: capped. Prefer tab.evaluate for targeted reads. */
    extract: async () => {
      const html = await page.content();
      return html.length > MAX_EXTRACT_CHARS
        ? `${html.slice(0, MAX_EXTRACT_CHARS)}\n…(truncated)`
        : html;
    },
    click: (selector: string) => page.click(selector),
    type: (selector: string, text: string) => page.type(selector, text),
    fill: (selector: string, value: string) =>
      page.evaluate(
        (sel, val) => {
          const el = document.querySelector<HTMLInputElement>(sel);
          if (!el) throw new Error(`no element matches ${sel}`);
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        },
        selector,
        value,
      ),
    press: (key: string) => page.keyboard.press(key as Parameters<Page["keyboard"]["press"]>[0]),
    scroll: (deltaX: number, deltaY: number) =>
      page.evaluate((dx, dy) => window.scrollBy(dx, dy), deltaX, deltaY),
    select: (selector: string, ...values: string[]) => page.select(selector, ...values),
    scrollIntoView: (selector: string) =>
      page.evaluate((sel) => {
        document.querySelector(sel)?.scrollIntoView();
      }, selector),
    waitForSelector: (
      selector: string,
      opts?: { timeout?: number; visible?: boolean; hidden?: boolean },
    ) =>
      page.waitForSelector(selector, {
        timeout: opts?.timeout ?? 15_000,
        ...(opts?.visible !== undefined ? { visible: opts.visible } : {}),
        ...(opts?.hidden !== undefined ? { hidden: opts.hidden } : {}),
      }),
    waitForNavigation: (opts?: {
      waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
      timeout?: number;
    }) =>
      page.waitForNavigation({
        waitUntil: opts?.waitUntil ?? "load",
        timeout: opts?.timeout ?? 30_000,
      }),
    evaluate: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      page.evaluate(fn, ...args),
  };
}

/** Navigation policy for action=open. Two settings, one scheme rule.
 *
 *  Default (local OFF): the same egress rule web_fetch enforces — the target
 *  must pass the url guard, which blocks loopback, RFC1918, link-local and the
 *  carrier-grade NAT range. That means a local dev server cannot be driven
 *  through this tool unless the workspace opts in.
 *
 *  Local ON (`.oma/settings.json` `browserLocalNetwork`, standalone only): a
 *  developer inspecting the app they are building needs http://localhost:3000,
 *  so the loopback/RFC1918 refusal is lifted — but ONLY that part. Cloud
 *  metadata keeps being refused (`isMetadataHost`), for the hostname AS WRITTEN
 *  and for the addresses it resolves to: 169.254.169.254, the CGNAT range and
 *  DNS names pointing into them are where instance credentials live, and a
 *  dev-server allowance must not become a credential-stealing primitive.
 *
 *  Both settings keep the scheme rule: http(s) only, so `file:///etc/passwd`
 *  is refused rather than rendered (a browser `file:` read would step outside
 *  the workspace sandbox the file tools enforce). `data:`/`about:` stay allowed
 *  because that is how this tool is exercised offline (its own tests) — NOT
 *  because they are inert: a data: document runs script and can fetch
 *  subresources, so that exemption is not a security boundary.
 *
 *  Scope: this hardens direct navigation only. `action=run` executes model JS
 *  with process access (see the header note) and a page can fetch subresources
 *  itself, so it is a deterministic barrier, not containment. A read_write Run
 *  has bash anyway.
 *
 *  Returns an error string when the URL must not be opened. */
export async function checkNavigationAllowed(
  url: string,
  allowLocalNetwork: boolean,
  /** Address resolver, injectable for offline tests. Default = real DNS. */
  resolve: (hostname: string) => Promise<string[]> = resolveHostAddresses,
): Promise<string | null> {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return `Error: invalid URL: ${url}`;
  }
  if (scheme === "data:" || scheme === "about:") return null;
  try {
    if (allowLocalNetwork) {
      const parsed = parseHttpUrl(url);
      if (isMetadataHost(parsed.hostname)) {
        return `Error: refused to open ${url}: cloud metadata endpoints are never reachable`;
      }
      // The hostname check above only sees literals and metadata NAMES. A DNS
      // name that RESOLVES into 169.254/16 or 100.64/10 (nip.io-style, or a
      // record the prompt-injector controls) is the same credential-stealing
      // primitive as typing the address, so the local opt-in resolves too.
      // Not TOCTOU-proof — Chromium re-resolves — same ceiling as web_fetch.
      const isLiteralIp =
        parsed.hostname.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname);
      if (!isLiteralIp) {
        const answers = await resolve(parsed.hostname);
        if (answers.some((a) => isMetadataHost(a))) {
          return `Error: refused to open ${url}: resolves to a cloud metadata address`;
        }
      }
      return null;
    }
    await assertSafeUrlDeep(url);
  } catch (err) {
    return `Error: refused to open ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

export function createBrowserTool(opts: {
  workspaceRoot: string;
  /** Opt-in: allow loopback/RFC1918 targets so a local dev server can be
   *  inspected. Off by default; cloud metadata stays refused either way.
   *  Standalone knob (`.oma/settings.json` `browserLocalNetwork`) — a product
   *  RPC run only honors it through the frozen run snapshot (deps.settings). */
  allowLocalNetwork?: boolean;
}): Tool {
  const screenshotDir = join(opts.workspaceRoot, ".oma", "screenshots");
  const allowLocalNetwork = opts.allowLocalNetwork === true;
  return {
    name: "browser",
    description:
      "Drive a real headless Chromium. action=open opens/reuses a named tab " +
      "(url, viewport); action=run executes async JS with `tab` in scope " +
      "(goto/observe/screenshot/click/type/fill/press/scroll/waitForSelector/" +
      "waitForNavigation/evaluate/extract/select); action=close releases tabs " +
      "(all: true releases every tab). Use for pages needing JS, interaction, " +
      "or screenshots — web_fetch for static reads. http(s) only: file: URLs are " +
      "refused, and localhost/private-network targets unless the workspace has " +
      "enabled local access.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "close", "run"], description: "Dispatch." },
        name: { type: "string", description: 'Tab id (default "main"); reused across calls.' },
        url: { type: "string", description: "open: navigate after the tab is ready." },
        code: { type: "string", description: "run: async function body; `tab` API in scope." },
        viewport: {
          type: "object",
          properties: { width: { type: "number" }, height: { type: "number" } },
          description: "open: viewport override.",
        },
        all: { type: "boolean", description: "close: release every tab." },
        timeout: {
          type: "number",
          description: "Wall-clock cap in seconds (default 30, max 300).",
        },
      },
      required: ["action"],
    },
    async execute(input: unknown, signal?: AbortSignal): Promise<ToolExecuteResult> {
      const args = input as {
        action?: string;
        name?: string;
        url?: string;
        code?: string;
        viewport?: { width?: number; height?: number };
        all?: boolean;
        timeout?: number;
      };
      const action = args.action;
      const name = args.name ?? "main";
      const timeoutS = Math.min(
        MAX_TIMEOUT_S,
        Math.max(MIN_TIMEOUT_S, args.timeout ?? DEFAULT_TIMEOUT_S),
      );
      const deadlineMs = timeoutS * 1000;

      if (action === "open") {
        if (args.url) {
          const refused = await checkNavigationAllowed(args.url, allowLocalNetwork);
          if (refused) return { content: refused, isError: true };
        }
        try {
          const browser = await getSharedBrowser();
          let entry = tabs.get(name);
          if (!entry) {
            entry = { name, page: await browser.newPage() };
            tabs.set(name, entry);
          }
          if (args.viewport?.width && args.viewport?.height) {
            await entry.page.setViewport({
              width: args.viewport.width,
              height: args.viewport.height,
            });
          }
          if (args.url) {
            await entry.page.goto(args.url, { waitUntil: "load", timeout: deadlineMs });
          }
          const title = await entry.page.title().catch(() => "");
          return {
            content: `Opened tab "${name}" — ${entry.page.url()}${title ? ` — ${title}` : ""}`,
          };
        } catch (err) {
          return {
            content: `Error: browser open failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }

      if (action === "close") {
        if (args.all) {
          const names = [...tabs.keys()];
          for (const n of names) await releaseTab(n);
          return { content: `Closed ${names.length} tab(s).` };
        }
        return { content: await releaseTab(name) };
      }

      if (action === "run") {
        const code = args.code;
        if (typeof code !== "string" || code.trim() === "") {
          return { content: "Error: code is required for action 'run'", isError: true };
        }
        const entry = tabs.get(name);
        if (!entry) {
          return {
            content: `Error: tab "${name}" is not open. Call action=open first.`,
            isError: true,
          };
        }
        const { page } = entry;
        const images: Array<{ mediaType: "image/png"; base64: string }> = [];
        const outputs: string[] = [];
        const plainTab = createTabApi(name, page, screenshotDir);
        // Screenshot wrapper: pushes a vision image block unless silent.
        const tab = {
          ...plainTab,
          screenshot: async (o?: { fullPage?: boolean; silent?: boolean }) => {
            const dest = await plainTab.screenshot(o);
            if (!o?.silent) {
              images.push({
                mediaType: "image/png",
                base64: readFileSync(dest).toString("base64"),
              });
            }
            return dest;
          },
        };
        const fn = new AsyncFunction("page", "tab", "browser", "assert", "wait", code);
        const started = Date.now();
        try {
          const returnValue = await Promise.race([
            fn(
              page,
              tab,
              page.browser(),
              (cond: unknown, msg?: string) => {
                if (!cond) throw new Error(msg ?? "assertion failed");
              },
              (ms: number) => new Promise((r) => setTimeout(r, ms)),
            ),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`run timed out after ${timeoutS}s`)), deadlineMs),
            ),
          ]);
          if (signal?.aborted) {
            await releaseTab(name);
            return { content: "Error: aborted", isError: true };
          }
          if (returnValue !== undefined) {
            outputs.push(
              typeof returnValue === "string"
                ? returnValue
                : (JSON.stringify(returnValue, null, 2) ?? String(returnValue)),
            );
          }
          if (outputs.length === 0) outputs.push(`Ran code on tab "${name}".`);
          const elapsed = `${Date.now() - started}ms`;
          const content =
            `${outputs.join("\n\n")}\n(${elapsed}` +
            `${images.length ? `, ${images.length} screenshot(s)` : ""})`;
          if (images.length > 0) {
            return {
              content,
              mediaType: "image/png",
              images: images.map((img) => ({ type: "image" as const, ...img })),
            } as unknown as ToolExecuteResult;
          }
          return { content };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/timed out/.test(message)) {
            // Closing the page is the only way to unblock a wedged
            // evaluation; the next call starts clean.
            await releaseTab(name);
            return {
              content: `Error: ${message} — tab "${name}" was killed; open it again.`,
              isError: true,
            };
          }
          return { content: `Error: ${message}`, isError: true };
        }
      }

      return {
        content: `Error: unknown action "${String(action)}" (open | close | run)`,
        isError: true,
      };
    },
  };
}
