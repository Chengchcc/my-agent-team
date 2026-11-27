/** Lightweight in-memory token-bucket rate limiter keyed by caller/resource.
 *  Used to protect sensitive or unauthenticated endpoints (/api/auth/verify,
 *  /api/workflow-triggers/:workflowId) from brute-force and flood traffic.
 *  Stale buckets are pruned automatically when the map grows past maxKeys. */
export interface TokenBucketOptions {
  /** Maximum burst tokens per key. */
  capacity: number;
  /** Sustained refill rate in tokens per second. */
  refillPerSec: number;
  /** Maximum distinct keys tracked before evicting idle entries. Default 4096. */
  maxKeys?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface TokenBucketLimiter {
  consume(key: string, cost?: number): RateLimitDecision;
  reset(key?: string): void;
  size(): number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export function createTokenBucketLimiter(opts: TokenBucketOptions): TokenBucketLimiter {
  const { capacity, refillPerSec, maxKeys = 4096 } = opts;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  function pruneIfNeeded(currentMs: number): void {
    if (buckets.size < maxKeys) return;
    // Evict buckets that have fully refilled (idle) first.
    const fullRefillMs = refillPerSec > 0 ? (capacity / refillPerSec) * 1000 : 60_000;
    for (const [k, b] of buckets) {
      if (currentMs - b.lastRefillMs >= fullRefillMs) {
        buckets.delete(k);
      }
      if (buckets.size < maxKeys * 0.75) break;
    }
    // If still full under a cardinality attack, evict oldest entries (Map insertion order).
    while (buckets.size >= maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  return {
    consume(key: string, cost = 1): RateLimitDecision {
      const currentMs = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        pruneIfNeeded(currentMs);
        bucket = { tokens: capacity, lastRefillMs: currentMs };
        buckets.set(key, bucket);
      } else {
        const elapsedSec = Math.max(0, (currentMs - bucket.lastRefillMs) / 1000);
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
        bucket.lastRefillMs = currentMs;
      }

      if (bucket.tokens >= cost) {
        bucket.tokens -= cost;
        return {
          allowed: true,
          remaining: Math.floor(bucket.tokens),
          retryAfterSec: 0,
        };
      }

      const deficit = cost - bucket.tokens;
      const retryAfterSec = refillPerSec > 0 ? Math.ceil(deficit / refillPerSec) : 60;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, retryAfterSec),
      };
    },

    reset(key?: string): void {
      if (key === undefined) buckets.clear();
      else buckets.delete(key);
    },

    size(): number {
      return buckets.size;
    },
  };
}
