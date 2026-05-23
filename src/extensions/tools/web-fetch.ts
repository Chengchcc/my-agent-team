import type { ToolContext } from '../../application/ports/tool-context';
import type { WebFetchArgs } from '../../application/contracts/tool-schemas/web-fetch';
import { getTavilyClient, raceWithAbort, isAbortError } from './tavily-shared';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface WebFetchOutput {
  url: string;
  title: string | null;
  content: string;
  images?: string[];
}

export async function webFetchExecute(
  args: WebFetchArgs,
  ctx: ToolContext,
): Promise<unknown> {
  const client = getTavilyClient();
  if (!client) {
    return {
      content: 'TAVILY_API_KEY environment variable not set. Web fetch is unavailable.',
      isError: true,
    };
  }

  try {
    const result = await raceWithAbort(
      ctx.signal,
      DEFAULT_TIMEOUT_MS,
      client.extract([args.url], {
        extractDepth: 'basic',
        format: 'markdown',
        query: args.prompt,
        timeout: DEFAULT_TIMEOUT_MS,
      }),
    );

    if (result.results.length > 0) {
      const first = result.results[0]!;
      return {
        url: first.url,
        title: first.title,
        content: first.rawContent,
        images: first.images,
      } satisfies WebFetchOutput;
    }

    if (result.failedResults.length > 0) {
      return {
        content: `Failed to fetch URL: ${result.failedResults[0]!.error}`,
        isError: true,
      };
    }

    return { content: 'No results returned for URL.', isError: true };
  } catch (err) {
    if (isAbortError(err)) {
      return { content: 'Web fetch aborted by user.', isError: true };
    }
    return {
      content: `Web fetch failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
