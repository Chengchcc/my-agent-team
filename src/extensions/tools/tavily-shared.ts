import { tavily } from '@tavily/core';
import type { TavilyClient } from '@tavily/core';

let _client: TavilyClient | null = null;

export function getTavilyClient(): TavilyClient | null {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  if (!_client) {
    _client = tavily({ apiKey });
  }
  return _client;
}

export function raceWithAbort<T>(
  signal: AbortSignal,
  timeoutMs: number,
  promise: Promise<T>,
): Promise<T> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
  });
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
