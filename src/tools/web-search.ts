import { z } from 'zod';
import { tavily } from '@tavily/core';
import { ZodTool } from './zod-tool';
import type { ToolContext } from '../agent/tool-dispatch/types';
import { settings } from '../config';

const SEARCH_MAX_RESULTS = 20;
const SEARCH_DEFAULT_RESULTS = 5;

const WebSearchSchema = z.object({
  query: z.string().describe('The search query.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_MAX_RESULTS)
    .default(SEARCH_DEFAULT_RESULTS)
    .describe(`Maximum number of results to return (1-${SEARCH_MAX_RESULTS}, default ${SEARCH_DEFAULT_RESULTS}).`),
  search_depth: z
    .enum(['basic', 'advanced'])
    .default('basic')
    .describe('Search depth: "basic" for faster results, "advanced" for more comprehensive results.'),
});

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
  domain?: string;
}

export interface WebSearchOutput {
  query: string;
  results: WebSearchResult[];
  answer?: string;
  total_results?: number;
  response_time?: number;
}

export class WebSearchTool extends ZodTool<typeof WebSearchSchema> {
  protected schema = WebSearchSchema;
  protected name = 'web_search';
  protected description =
    'Search the web using Tavily AI search engine. Returns relevant web pages with titles, URLs, content snippets, and relevance scores. Use this for finding current information, news, documentation, or any topic requiring real-time web data.';
  readonly = true;

  private explicitApiKey: string | null | undefined;

  constructor(apiKey?: string | null) {
    super();
    this.explicitApiKey = apiKey;
  }

  /** Resolve API key lazily so settings proxy access is deferred to handle time. */
  private get apiKey(): string | null {
    if (this.explicitApiKey !== undefined) return this.explicitApiKey;
    try {
      return settings.tools.tavily.apiKey;
    } catch {
      return null;
    }
  }

  protected async handle(
    args: z.infer<typeof WebSearchSchema>,
    ctx: ToolContext,
  ): Promise<WebSearchOutput> {
    const key = this.apiKey;
    if (!key) {
      throw new Error(
        'Tavily API key not configured. Set tools.tavily.apiKey in settings.yml or TAVILY_API_KEY environment variable.',
      );
    }

    const tvly = tavily({ apiKey: key });
    const searchPromise = tvly.search(args.query, {
      searchDepth: args.search_depth,
      maxResults: args.max_results,
    });

    if (ctx.signal) {
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Search aborted', 'AbortError'));
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        searchPromise
          .then((data) => {
            ctx.signal.removeEventListener('abort', onAbort);
            resolve(this.formatResponse(args.query, data));
          })
          .catch((err) => {
            ctx.signal.removeEventListener('abort', onAbort);
            reject(err);
          });
        if (ctx.signal.aborted) {
          onAbort();
        }
      });
    }

    const data = await searchPromise;
    return this.formatResponse(args.query, data);
  }

  private formatResponse(
    query: string,
    data: Record<string, unknown>,
  ): WebSearchOutput {
    const results: WebSearchResult[] = Array.isArray(data.results)
      ? (data.results as Array<Record<string, unknown>>).map((r) => ({
          title: String(r.title ?? ''),
          url: String(r.url ?? ''),
          content: String(r.content ?? ''),
          score: Number(r.score ?? 0),
          ...(r.published_date ? { published_date: String(r.published_date) } : r.publishedDate ? { published_date: String(r.publishedDate) } : {}),
          ...(r.domain ? { domain: String(r.domain) } : {}),
        }))
      : [];

    return {
      query,
      results,
      ...(typeof data.answer === 'string' ? { answer: data.answer } : {}),
      ...(typeof data.total_results === 'number'
        ? { total_results: data.total_results }
        : {}),
      ...(typeof data.responseTime === 'number'
        ? { response_time: data.responseTime }
        : {}),
    };
  }
}
