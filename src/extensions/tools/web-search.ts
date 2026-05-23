import type { ToolContext } from '../../application/ports/tool-context';
import type { WebSearchArgs } from '../../application/contracts/tool-schemas/web-search';
import { getTavilyClient, raceWithAbort, isAbortError } from './tavily-shared';

const MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const SEARCH_DEPTH = 'basic';

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate?: string;
}

export interface WebSearchOutput {
  query: string;
  answer?: string;
  results: WebSearchResult[];
  responseTime: number;
}

export async function webSearchExecute(
  args: WebSearchArgs,
  ctx: ToolContext,
): Promise<unknown> {
  const client = getTavilyClient();
  if (!client) {
    return {
      content: 'TAVILY_API_KEY environment variable not set. Web search is unavailable.',
      isError: true,
    };
  }

  try {
    const result = await raceWithAbort(
      ctx.signal,
      DEFAULT_TIMEOUT_MS,
      client.search(args.query, {
        searchDepth: SEARCH_DEPTH,
        maxResults: MAX_RESULTS,
        includeAnswer: 'basic',
      }),
    );

    return {
      query: result.query,
      answer: result.answer,
      results: result.results.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        publishedDate: r.publishedDate,
      })),
      responseTime: result.responseTime,
    } satisfies WebSearchOutput;
  } catch (err) {
    if (isAbortError(err)) {
      return { content: 'Web search aborted by user.', isError: true };
    }
    return {
      content: `Web search failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
