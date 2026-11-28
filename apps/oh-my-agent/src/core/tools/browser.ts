import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolExecuteResult } from "@chengchenccc/message";
import type { Browser, HTTPRequest, Page } from "puppeteer-core";
import {
  assertSafeUrlDeep,
  isMetadataHost,
  parseHttpUrl,
  resolveHostAddresses,
} from "./url-guard.js";
import { WorkspaceSandbox } from "./workspace-sandbox.js";

/** browser: open, reuse, close, and drive headless Chromium tabs via
 *  DECLARATIVE steps only (no host-process `AsyncFunction` / `eval`).
 *
 *  Security invariants:
 *  - Model JavaScript ONLY runs inside the Chromium page sandbox (`op: "evaluate"`),
 *    never in the host Bun process (`process.env`, FS, `Bun.spawn` unreachable).
 *  - Every navigation, redirect hop, and subresource request on every tab is
 *    interrogated via Puppeteer request interception (`checkNavigationAllowed`).
 *  - Tab names are restricted to `[a-zA-Z0-9_-]{1,64}` and screenshot output
 *    paths are verified through `WorkspaceSandbox.validateNew`. */

interface TabEntry {
  readonly name: string;
  readonly page: Page;
  readonly allowLocalNetwork: boolean;
}

export type BrowserStep =
  | {
      op: "goto";
      url: string;
      waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
    }
  | { op: "title" }
  | { op: "url" }
  | { op: "observe" }
  | { op: "extract" }
  | { op: "screenshot"; fullPage?: boolean; silent?: boolean }
  | { op: "click"; selector: string }
  | { op: "type"; selector: string; text: string }
  | { op: "fill"; selector: string; value: string }
  | { op: "press"; key: string }
  | { op: "scroll"; deltaX?: number; deltaY?: number }
  | { op: "select"; selector: string; values: string[] }
  | { op: "scrollIntoView"; selector: string }
  | {
      op: "waitForSelector";
      selector: string;
      timeout?: number;
      visible?: boolean;
      hidden?: boolean;
    }
  | {
      op: "waitForNavigation";
      waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
      timeout?: number;
    }
  | { op: "wait"; ms: number }
  | { op: "evaluate"; expression: string };

const SAFE_TAB_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Process-global tab registry (the bash/eval bg-job pattern): the TUI
 *  shares tabs across Runs in one process; the backend runs one Run per
 *  process, so semantics are unchanged there. */
const tabs = new Map<string, TabEntry>();
let sharedBrowser: Browser | null = null;
let launching: Promise<Browser> | null = null;

const DEFAULT_VIEWPORT = { width: 1365, height: 768 };
const MIN_TIMEOUT_S = 1;
const MAX_TIMEOUT_S = 300;
/** Wrapper backstop ceiling matching MAX_TIMEOUT_S so multi-step browser calls
 *  with timeout > 30s are not prematurely killed by the generic 30s wrapper. */
export const MAX_BROWSER_TIMEOUT_MS = MAX_TIMEOUT_S * 1000;
const DEFAULT_TIMEOUT_S = 30;
/** observe/extract output caps: the model, not the page, is the sink. */
const MAX_OBSERVE_BYTES = 12_000;
const MAX_EXTRACT_CHARS = 20_000;
const MAX_STEPS_PER_CALL = 50;

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

const SYSTEM_BROWSER_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];

/** Resolve the Chromium executable: PUPPETEER_EXECUTABLE_PATH, then the
 *  puppeteer cache for this platform, then a system browser. */
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

function chromeLaunchArgs(): string[] {
  const args = ["--disable-blink-features=AutomationControlled"];
  // Keep Chromium's OS sandbox ON when possible; Linux containers running as
  // root without userns require --no-sandbox (or explicit env opt-in).
  const needsNoSandbox =
    process.env.OMA_BROWSER_NO_SANDBOX === "1" ||
    (process.platform === "linux" &&
      typeof process.getuid === "function" &&
      process.getuid() === 0);
  if (needsNoSandbox) {
    args.unshift("--no-sandbox", "--disable-setuid-sandbox");
  }
  return args;
}

async function loadPuppeteer() {
  try {
    return await import("puppeteer-core");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `puppeteer-core is an optional dependency and is not installed (${detail}). Install it (e.g. bun add puppeteer-core) to enable the browser tool.`,
      { cause: err },
    );
  }
}

async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser?.connected) return sharedBrowser;
  if (launching) return launching;
  launching = (async () => {
    const puppeteer = await loadPuppeteer();
    const browser = await puppeteer.launch({
      executablePath: resolveChromeExecutable(),
      headless: true,
      args: chromeLaunchArgs(),
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

export async function canLaunchChromium(boundMs = 8_000): Promise<boolean> {
  let browser: Browser | undefined;
  let timer: Timer | undefined;
  try {
    const puppeteer = await loadPuppeteer();
    const launched = await Promise.race([
      puppeteer.launch({
        executablePath: resolveChromeExecutable(),
        headless: true,
        args: chromeLaunchArgs(),
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
    await browser?.close().catch(() => {});
  }
}

export async function closeSharedBrowserForTests(): Promise<void> {
  for (const name of [...tabs.keys()]) await releaseTab(name);
  const browser = sharedBrowser;
  sharedBrowser = null;
  await browser?.close().catch(() => {});
}

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

/** Install all-hop request interception on a Puppeteer page so 302 redirects,
 *  subresource fetches, and script-initiated navigations cannot bypass the
 *  egress/metadata policy. */
async function installRequestGuard(page: Page, allowLocalNetwork: boolean): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", (req: HTTPRequest) => {
    void (async () => {
      try {
        const url = req.url();
        const refused = await checkNavigationAllowed(url, allowLocalNetwork);
        if (refused) {
          await req.abort("blockedbyclient").catch(() => {});
          return;
        }
        await req.continue().catch(() => {});
      } catch {
        await req.abort("failed").catch(() => {});
      }
    })();
  });
}

/** Validate tab name against path-traversal characters before using it in
 *  screenshot file names (`<workspace>/.oma/screenshots/<name>-<ts>.png`). */
export function isValidTabName(name: string): boolean {
  return SAFE_TAB_NAME.test(name);
}

/** Navigation policy for action=open, goto, redirects, and subresources.
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

async function executeBrowserStep(
  step: BrowserStep,
  ctx: {
    name: string;
    page: Page;
    allowLocalNetwork: boolean;
    workspaceRoot: string;
    screenshotDir: string;
    deadlineMs: number;
    signal?: AbortSignal;
    images: Array<{ mediaType: "image/png"; base64: string }>;
  },
): Promise<unknown> {
  const {
    name,
    page,
    allowLocalNetwork,
    workspaceRoot,
    screenshotDir,
    deadlineMs,
    signal,
    images,
  } = ctx;
  switch (step.op) {
    case "goto": {
      const refused = await checkNavigationAllowed(step.url, allowLocalNetwork);
      if (refused) throw new Error(refused);
      await page.goto(step.url, {
        waitUntil: step.waitUntil ?? "load",
        timeout: Math.min(30_000, deadlineMs),
      });
      return { url: page.url(), title: await page.title().catch(() => "") };
    }
    case "title":
      return await page.title();
    case "url":
      return page.url();
    case "observe": {
      const snap = await page.accessibility.snapshot();
      const text = JSON.stringify(snap, null, 1) ?? "";
      return text.length > MAX_OBSERVE_BYTES
        ? `${text.slice(0, MAX_OBSERVE_BYTES)}\n…(truncated — narrow with evaluate)`
        : text;
    }
    case "extract": {
      const html = await page.content();
      return html.length > MAX_EXTRACT_CHARS
        ? `${html.slice(0, MAX_EXTRACT_CHARS)}\n…(truncated)`
        : html;
    }
    case "screenshot": {
      mkdirSync(screenshotDir, { recursive: true });
      const rawDest = join(screenshotDir, `${name}-${Date.now()}.png`);
      const dest = new WorkspaceSandbox(workspaceRoot).validateNew(rawDest);
      await page.screenshot({ fullPage: step.fullPage ?? false, path: dest });
      if (!step.silent) {
        images.push({
          mediaType: "image/png",
          base64: readFileSync(dest).toString("base64"),
        });
      }
      return dest;
    }
    case "click":
      await page.click(step.selector);
      return { clicked: step.selector };
    case "type":
      await page.type(step.selector, step.text);
      return { typed: step.selector };
    case "fill":
      await page.evaluate(
        (sel, val) => {
          const el = document.querySelector<HTMLInputElement>(sel);
          if (!el) throw new Error(`no element matches ${sel}`);
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        },
        step.selector,
        step.value,
      );
      return { filled: step.selector };
    case "press":
      await page.keyboard.press(step.key as Parameters<Page["keyboard"]["press"]>[0]);
      return { pressed: step.key };
    case "scroll":
      await page.evaluate((dx, dy) => window.scrollBy(dx, dy), step.deltaX ?? 0, step.deltaY ?? 0);
      return { scrolled: [step.deltaX ?? 0, step.deltaY ?? 0] };
    case "select":
      return await page.select(step.selector, ...(step.values ?? []));
    case "scrollIntoView":
      await page.evaluate((sel) => {
        document.querySelector(sel)?.scrollIntoView();
      }, step.selector);
      return { scrolledIntoView: step.selector };
    case "waitForSelector":
      await page.waitForSelector(step.selector, {
        timeout: Math.min(step.timeout ?? 15_000, deadlineMs),
        ...(step.visible !== undefined ? { visible: step.visible } : {}),
        ...(step.hidden !== undefined ? { hidden: step.hidden } : {}),
      });
      return { found: step.selector };
    case "waitForNavigation":
      await page.waitForNavigation({
        waitUntil: step.waitUntil ?? "load",
        timeout: Math.min(step.timeout ?? 30_000, deadlineMs),
      });
      return { url: page.url() };
    case "wait": {
      const ms = Math.max(0, Number(step.ms) || 0);
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        const onAbort = () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        };
        const t = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        t.unref?.();
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      return { waitedMs: ms };
    }
    case "evaluate": {
      // Runs strictly inside the Chromium page sandbox — NEVER in the host Bun process.
      const expr = String(step.expression ?? "");
      if (!expr.trim()) throw new Error("evaluate step requires non-empty expression");
      return await page.evaluate(expr);
    }
    default:
      throw new Error(`unknown browser step op: ${String((step as { op?: unknown }).op)}`);
  }
}

export function createBrowserTool(opts: {
  workspaceRoot: string;
  /** Opt-in: allow loopback/RFC1918 targets so a local dev server can be
   *  inspected. Off by default; cloud metadata stays refused either way. */
  allowLocalNetwork?: boolean;
}): Tool {
  const screenshotDir = join(opts.workspaceRoot, ".oma", "screenshots");
  const allowLocalNetwork = opts.allowLocalNetwork === true;
  return {
    name: "browser",
    description:
      "Drive a real headless Chromium tab safely via declarative steps. " +
      "action=open opens/reuses a named tab (url, viewport); " +
      "action=run executes a declarative `steps` array (goto, title, url, observe, extract, " +
      "screenshot, click, type, fill, press, scroll, select, scrollIntoView, waitForSelector, " +
      "waitForNavigation, wait, evaluate — where `evaluate` runs strictly inside the browser page); " +
      "action=close releases tabs (all: true releases every tab). " +
      "All navigations, redirects, and subresources obey the http(s) + metadata egress policy.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "close", "run"], description: "Dispatch." },
        name: {
          type: "string",
          description: 'Tab id ([a-zA-Z0-9_-]{1,64}, default "main"); reused across calls.',
        },
        url: { type: "string", description: "open: navigate after the tab is ready." },
        steps: {
          type: "array",
          description:
            "run: ordered declarative steps (e.g. [{op:'title'}, {op:'click', selector:'#b'}, {op:'screenshot'}]).",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: [
                  "goto",
                  "title",
                  "url",
                  "observe",
                  "extract",
                  "screenshot",
                  "click",
                  "type",
                  "fill",
                  "press",
                  "scroll",
                  "select",
                  "scrollIntoView",
                  "waitForSelector",
                  "waitForNavigation",
                  "wait",
                  "evaluate",
                ],
              },
              url: { type: "string" },
              selector: { type: "string" },
              text: { type: "string" },
              value: { type: "string" },
              values: { type: "array", items: { type: "string" } },
              key: { type: "string" },
              deltaX: { type: "number" },
              deltaY: { type: "number" },
              ms: { type: "number" },
              expression: {
                type: "string",
                description: "evaluate: JS expression evaluated inside the browser page context.",
              },
              fullPage: { type: "boolean" },
              silent: { type: "boolean" },
              timeout: { type: "number" },
              visible: { type: "boolean" },
              hidden: { type: "boolean" },
              waitUntil: {
                type: "string",
                enum: ["load", "domcontentloaded", "networkidle0", "networkidle2"],
              },
            },
            required: ["op"],
          },
        },
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
        steps?: BrowserStep[];
        viewport?: { width?: number; height?: number };
        all?: boolean;
        timeout?: number;
      };
      const action = args.action;
      const name = args.name ?? "main";
      if (action !== "close" || !args.all) {
        if (!isValidTabName(name)) {
          return {
            content: `Error: invalid tab name "${name}" (allowed: [a-zA-Z0-9_-]{1,64})`,
            isError: true,
          };
        }
      }
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
            const page = await browser.newPage();
            await installRequestGuard(page, allowLocalNetwork);
            entry = { name, page, allowLocalNetwork };
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
        if (typeof args.code === "string" && !Array.isArray(args.steps)) {
          return {
            content:
              "Error: raw host `code` execution is disabled for security. Pass declarative `steps` (e.g. [{ op: 'evaluate', expression: '...' }, { op: 'screenshot' }]).",
            isError: true,
          };
        }
        const steps = args.steps;
        if (!Array.isArray(steps) || steps.length === 0) {
          return {
            content: "Error: non-empty `steps` array is required for action 'run'",
            isError: true,
          };
        }
        if (steps.length > MAX_STEPS_PER_CALL) {
          return {
            content: `Error: too many steps (${steps.length} > max ${MAX_STEPS_PER_CALL})`,
            isError: true,
          };
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
        const started = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        try {
          const results = await Promise.race([
            (async () => {
              const out: unknown[] = [];
              for (const step of steps) {
                if (signal?.aborted) throw new Error("aborted");
                const remainingMs = Math.max(100, deadlineMs - (Date.now() - started));
                out.push(
                  await executeBrowserStep(step, {
                    name,
                    page,
                    allowLocalNetwork: entry.allowLocalNetwork,
                    workspaceRoot: opts.workspaceRoot,
                    screenshotDir,
                    deadlineMs: remainingMs,
                    signal,
                    images,
                  }),
                );
              }
              return out;
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`run timed out after ${timeoutS}s`)),
                deadlineMs,
              );
              timer.unref?.();
              if (signal) {
                if (signal.aborted) {
                  reject(new Error("aborted"));
                } else {
                  onAbort = () => reject(new Error("aborted"));
                  signal.addEventListener("abort", onAbort, { once: true });
                }
              }
            }),
          ]);
          if (signal?.aborted) {
            await releaseTab(name);
            return { content: "Error: aborted", isError: true };
          }
          const elapsed = `${Date.now() - started}ms`;
          const summary = JSON.stringify(results.length === 1 ? results[0] : results, null, 2);
          const content =
            `${summary}\n(${elapsed}` +
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
            await releaseTab(name);
            return {
              content: `Error: ${message} — tab "${name}" was killed; open it again.`,
              isError: true,
            };
          }
          if (message === "aborted" || signal?.aborted) {
            await releaseTab(name);
            return { content: "Error: aborted", isError: true };
          }
          return { content: `Error: ${message}`, isError: true };
        } finally {
          if (timer) clearTimeout(timer);
          if (onAbort && signal) signal.removeEventListener("abort", onAbort);
        }
      }

      return {
        content: `Error: unknown action "${String(action)}" (open | close | run)`,
        isError: true,
      };
    },
  };
}
