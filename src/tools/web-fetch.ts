import { z } from 'zod';
import { tavily } from '@tavily/core';
import { ZodTool } from './zod-tool';
import type { ToolContext } from '../agent/tool-dispatch/types';
import { settings } from '../config';
import { debugLog } from '../utils/debug';

const DEFAULT_MAX_CHARS = 50_000;
const MAX_CHARS_LIMIT = 200_000;
const MIN_CHARS_LIMIT = 1_000;
const HEADLESS_TIMEOUT_MS = 30_000;

const WebFetchSchema = z.object({
  url: z.string().url().describe('The URL to fetch content from. Must be a fully-formed valid URL.'),
  mode: z
    .enum(['markdown', 'text'])
    .default('markdown')
    .describe('Output format: "markdown" for structured content with headings/links, "text" for plain text.'),
  maxChars: z
    .number()
    .int()
    .min(MIN_CHARS_LIMIT)
    .max(MAX_CHARS_LIMIT)
    .default(DEFAULT_MAX_CHARS)
    .describe(`Maximum characters to return (${MIN_CHARS_LIMIT.toLocaleString()}-${MAX_CHARS_LIMIT.toLocaleString()}, default ${DEFAULT_MAX_CHARS.toLocaleString()}).`),
});

export interface WebFetchOutput {
  url: string;
  title: string | null;
  content: string;
  format: 'markdown' | 'text';
  truncated: boolean;
  extractedVia: 'tavily' | 'headless';
}

interface HeadlessResult {
  title: string | null;
  content: string;
}

/**
 * Fetch a URL using headless Chrome (Puppeteer).
 * Dynamically imports puppeteer — only loaded when Tavily is unavailable.
 */
async function fetchViaHeadless(url: string): Promise<HeadlessResult> {
  // Dynamic import — puppeteer is only loaded when this fallback is triggered
  const puppeteer = await import('puppeteer');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    try {
      await page.setUserAgent(
        'Mozilla/5.0 (compatible; MyAgent/1.0; +https://github.com/my-agent)',
      );
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: HEADLESS_TIMEOUT_MS,
      });

      const result = await page.evaluate(() => {
        const title = document.title || null;
        // Remove script/style/noscript elements before extracting text
        const clone = document.body.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('script, style, noscript, nav, footer, iframe').forEach(el => el.remove());
        const content = clone.innerText || '';
        return { title, content };
      });

      return result;
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

export class WebFetchTool extends ZodTool<typeof WebFetchSchema> {
  protected schema = WebFetchSchema;
  protected name = 'web_fetch';
  protected description =
    'Fetch content from a URL and return cleaned, structured text. ' +
    'Uses Tavily Extract API (when API key configured) for JS-aware extraction with readability filtering. ' +
    'Falls back to headless Chrome for SPA/JS-rendered pages. ' +
    'Returns title + main content as markdown or plain text. ' +
    'Strips navigation, sidebars, footers, ads, and styling.';
  readonly = true;

  private _fetchHeadless: (url: string) => Promise<HeadlessResult>;
  private _tavilyExtract: (url: string, mode: 'markdown' | 'text', apiKey: string) => Promise<HeadlessResult>;

  constructor(
    fetchHeadless?: (url: string) => Promise<HeadlessResult>,
    tavilyExtract?: (url: string, mode: 'markdown' | 'text', apiKey: string) => Promise<HeadlessResult>,
  ) {
    super();
    this._fetchHeadless = fetchHeadless ?? fetchViaHeadless;
    this._tavilyExtract = tavilyExtract ?? extractViaTavily;
  }

  protected async handle(
    args: z.infer<typeof WebFetchSchema>,
    ctx: ToolContext,
  ): Promise<WebFetchOutput> {
    const { url, mode, maxChars } = args;

    let title: string | null = null;
    let content: string;
    let extractedVia: 'tavily' | 'headless';

    // Try Tavily Extract first
    const apiKey = this.resolveApiKey();
    if (apiKey) {
      try {
        const result = await this.tavilyWithTimeout(url, mode, apiKey, ctx.signal);
        title = result.title;
        content = result.content;
        extractedVia = 'tavily';
      } catch (err) {
        debugLog(`Tavily extract failed for ${url}: ${String(err)}, falling back to headless`);
        const headlessResult = await this.fetchWithTimeout(url, ctx.signal);
        title = headlessResult.title;
        content = headlessResult.content;
        extractedVia = 'headless';
      }
    } else {
      debugLog(`No Tavily API key configured, using headless fetch for ${url}`);
      const headlessResult = await this.fetchWithTimeout(url, ctx.signal);
      title = headlessResult.title;
      content = headlessResult.content;
      extractedVia = 'headless';
    }

    // Truncate if needed
    const truncated = content.length > maxChars;
    if (truncated) {
      content = content.slice(0, maxChars) + '\n\n[Content truncated...]';
    }

    return { url, title, content, format: mode, truncated, extractedVia };
  }

  /** Wrap headless fetch with abort signal support */
  private fetchWithTimeout(url: string, signal: AbortSignal): Promise<HeadlessResult> {
    if (signal.aborted) {
      return Promise.reject(new DOMException('Fetch aborted', 'AbortError'));
    }

    return new Promise<HeadlessResult>((resolve, reject) => {
      const onAbort = () => reject(new DOMException('Fetch aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });

      this._fetchHeadless(url)
        .then(result => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        })
        .catch(err => {
          signal.removeEventListener('abort', onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        });

      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private resolveApiKey(): string | null {
    try {
      return settings.tools.tavily.apiKey;
    } catch {
      return null;
    }
  }

  /** Wrap Tavily extract with abort signal support */
  private tavilyWithTimeout(url: string, mode: 'markdown' | 'text', apiKey: string, signal: AbortSignal): Promise<HeadlessResult> {
    if (signal.aborted) {
      return Promise.reject(new DOMException('Fetch aborted', 'AbortError'));
    }

    return new Promise<HeadlessResult>((resolve, reject) => {
      const onAbort = () => reject(new DOMException('Fetch aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });

      this._tavilyExtract(url, mode, apiKey)
        .then(result => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        })
        .catch(err => {
          signal.removeEventListener('abort', onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        });

      if (signal.aborted) {
        onAbort();
      }
    });
  }
}

/** Default Tavily Extract implementation */
async function extractViaTavily(
  url: string,
  mode: 'markdown' | 'text',
  apiKey: string,
): Promise<HeadlessResult> {
  const tvly = tavily({ apiKey });
  const response = await tvly.extract([url], {
    format: mode,
    extractDepth: 'basic',
  });

  const result = response.results[0];
  if (!result || !result.rawContent) {
    throw new Error('Tavily returned empty content');
  }

  return {
    title: result.title ?? null,
    content: result.rawContent,
  };
}

