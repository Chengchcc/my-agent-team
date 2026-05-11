import type { MemoryEntry, MemoryRetriever, MemoryStore } from './types';

const KEYWORD_WEIGHT = 0.35;
const TAG_WEIGHT = 0.25;
const RECENCY_WEIGHT = 0.20;
const INTRINSIC_WEIGHT = 0.10;
const USAGE_WEIGHT = 0.10;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY;
const RECENCY_HALF_LIFE_DAYS = 30;
const USAGE_CAP_FOR_SCORE = 10;

const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_SEARCH_THRESHOLD = 0.1;
const SEARCH_CANDIDATE_MULTIPLIER = 3;
const SEARCH_CANDIDATE_MIN = 30;

export class KeywordRetriever implements MemoryRetriever {
  constructor(
    private generalStore: MemoryStore,
  ) {}

  async search(
    query: string,
    options: { limit?: number; threshold?: number } = {},
  ): Promise<MemoryEntry[]> {
    const { limit = DEFAULT_SEARCH_LIMIT, threshold = DEFAULT_SEARCH_THRESHOLD } = options;
    const queryTokens = this.tokenize(query.toLowerCase());

    // Pre-filter at DB level to avoid loading all entries
    const store = this.generalStore as MemoryStore & { searchByText?: (q: string, limit: number) => Promise<MemoryEntry[]> };
    const candidates = store.searchByText
      ? await store.searchByText(query, Math.max(limit * SEARCH_CANDIDATE_MULTIPLIER, SEARCH_CANDIDATE_MIN))
      : await this.generalStore.getAll();

    const scored = candidates
      .map(entry => ({
        entry,
        score: this.scoreEntry(entry, queryTokens),
      }))
      .filter(s => s.score >= threshold);

    const sorted = scored.sort((a, b) => b.score - a.score);
    return sorted.slice(0, limit).map(s => s.entry);
  }

  private tokenize(text: string): string[] {
    const tokens: string[] = [];
    const regex = /([a-z0-9]{2,})|([\u4e00-\u9fa5])/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[1]) tokens.push(match[1]);
      else if (match[2]) tokens.push(match[2]);
    }
    return [...new Set(tokens)];
  }

  private scoreEntry(entry: MemoryEntry, queryTokens: string[]): number {
    const entryTextTokens = this.tokenize(entry.text.toLowerCase());
    const entryTags = entry.tags?.map(t => t.toLowerCase()) ?? [];

    const keywordMatches = queryTokens.filter(t =>
      entryTextTokens.some(et => et.includes(t) || t.includes(et))
    ).length;
    const keywordScore = keywordMatches / Math.max(queryTokens.length, 1);

    const tagMatches = queryTokens.filter(t =>
      entryTags.some(et => et.includes(t) || t.includes(et))
    ).length;
    const tagScore = queryTokens.length > 0
      ? tagMatches / Math.max(queryTokens.length, 1)
      : 0;

    if (keywordMatches === 0 && tagMatches === 0) return 0;

    const latestTs = Math.max(
      entry.lastHitAt ?? 0,
      new Date(entry.created).getTime(),
    );
    const ageMs = Date.now() - latestTs;
    const ageDays = ageMs / MS_PER_DAY;
    const recencyScore = Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);

    const weightScore = entry.weight;

    const usageCount = entry.usageCount ?? 0;
    const usageScore = Math.min(usageCount, USAGE_CAP_FOR_SCORE) / USAGE_CAP_FOR_SCORE;

    return (
      keywordScore * KEYWORD_WEIGHT +
      tagScore * TAG_WEIGHT +
      recencyScore * RECENCY_WEIGHT +
      weightScore * INTRINSIC_WEIGHT +
      usageScore * USAGE_WEIGHT
    );
  }
}
