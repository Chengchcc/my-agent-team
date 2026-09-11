import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolExecuteResult } from "@chengchenccc/message";
import type { Browser, Page } from "puppeteer-core";

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

/** Resolve the Chromium executable: PUPPETEER_EXECUTABLE_PATH, then the
 *  puppeteer cache (newest chrome-linux-*), then a system browser. */
export function resolveChromeExecutable(): string {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) return fromEnv;
  const cache = join(homedir(), ".cache", "puppeteer", "chrome");
  try {
    const versions = readdirSync(cache)
      .filter((d) => d.startsWith("linux-"))
      .sort()
      .reverse();
    for (const v of versions) {
      if (!readdirSync(join(cache, v)).includes("chrome-linux64")) continue;
      return join(cache, v, "chrome-linux64", "chrome");
    }
  } catch {
    /* no cache dir */
  }
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

export function createBrowserTool(opts: { workspaceRoot: string }): Tool {
  const screenshotDir = join(opts.workspaceRoot, ".oma", "screenshots");
  return {
    name: "browser",
    description:
      "Drive a real headless Chromium. action=open opens/reuses a named tab " +
      "(url, viewport); action=run executes async JS with `tab` in scope " +
      "(goto/observe/screenshot/click/type/fill/press/scroll/waitForSelector/" +
      "waitForNavigation/evaluate/extract/select); action=close releases tabs " +
      "(all: true releases every tab). Use for pages needing JS, interaction, " +
      "or screenshots — web_fetch for static reads.",
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
