import type { ToolMiddleware } from '../middleware';
import type { ToolCall } from '../../../types';
import type { ToolContext } from '../types';
import { stat } from 'fs/promises';

const READ_CACHE_MAX_ENTRIES = 100;
const WEB_FETCH_CACHE_TTL_MINUTES = 5;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const WEB_FETCH_CACHE_TTL_MS = WEB_FETCH_CACHE_TTL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

interface CacheEntry {
  result: unknown;
  mtimeMs?: number;
  fetchedAt?: number;
}

export class ReadCacheMiddleware implements ToolMiddleware {
  name = 'read-cache';
  private cache = new Map<string, CacheEntry>();
  private maxEntries = READ_CACHE_MAX_ENTRIES;

  async handle(toolCall: ToolCall, _ctx: ToolContext, next: () => Promise<unknown>): Promise<unknown> {
    if (toolCall.name === 'web_fetch') {
      return this.handleWebFetch(toolCall, next);
    }

    if (toolCall.name !== 'read') return next();

    const path = toolCall.arguments.path as string;
    const startLine = (toolCall.arguments.start_line as number | undefined) ?? '';
    const endLine = (toolCall.arguments.end_line as number | undefined) ?? '';
    const key = `read:${path}:${startLine}:${endLine}`;

    const cached = this.cache.get(key);
    try {
      const fileStat = await stat(path);
      if (cached && cached.mtimeMs === fileStat.mtimeMs) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.result;
      }
    } catch {
      // stat failed - skip cache
    }

    const result = await next();

    this.evictIfFull();

    // Cache with mtime
    try {
      const fileStat = await stat(path);
      this.cache.set(key, { result, mtimeMs: fileStat.mtimeMs });
    } catch {
      // stat failed - don't cache
    }

    return result;
  }

  private async handleWebFetch(toolCall: ToolCall, next: () => Promise<unknown>): Promise<unknown> {
    const url = toolCall.arguments.url as string;
    const mode = (toolCall.arguments.mode as string) ?? 'markdown';
    const key = `web_fetch:${url}:${mode}`;

    const cached = this.cache.get(key);
    if (cached && cached.fetchedAt) {
      const age = Date.now() - cached.fetchedAt;
      if (age < WEB_FETCH_CACHE_TTL_MS) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.result;
      }
    }

    const result = await next();

    this.evictIfFull();

    this.cache.set(key, { result, fetchedAt: Date.now() });

    return result;
  }

  private evictIfFull(): void {
    if (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
  }

  /** Clear cache manually (for testing) */
  clear(): void {
    this.cache.clear();
  }
}
