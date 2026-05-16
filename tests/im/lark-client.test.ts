import { describe, it, expect, vi, afterEach } from 'bun:test';
import { getLarkClient } from '../../src/im/lark/client';

describe('getLarkClient (factory)', () => {
  // E01: getLarkClient returns same instance for same appId+secret
  it('returns same instance for same appId and secret (E01)', () => {
    const appId = 'cli_test_app_001';
    const secret = 'test_secret_abc123';
    const client1 = getLarkClient(appId, secret);
    const client2 = getLarkClient(appId, secret);
    expect(client1).toBe(client2);
    expect(client1.appId).toBe(appId);
    expect(client2.appId).toBe(appId);
  });

  // E02: getLarkClient throws on appSecret mismatch
  it('throws on appSecret mismatch for same appId (E02)', () => {
    const appId = 'cli_test_app_002';
    const secret = 'test_secret_abc123';
    const client = getLarkClient(appId, secret);
    expect(client).toBeDefined();

    expect(() => getLarkClient(appId, 'different_secret_xyz789')).toThrow(
      `[lark] appSecret mismatch for appId=${appId}`,
    );
  });

  // E08: Different appIds get different instances
  it('different appIds get different instances (E08)', () => {
    const appId1 = 'cli_test_app_a';
    const appId2 = 'cli_test_app_b';
    const secret = 'shared_secret';

    const client1 = getLarkClient(appId1, secret);
    const client2 = getLarkClient(appId2, secret);

    expect(client1).not.toBe(client2);
    expect(client1.appId).toBe(appId1);
    expect(client2.appId).toBe(appId2);
  });

  it('same appId with same secret always returns the same reference', () => {
    const appId = 'cli_test_app_cached';
    const secret = 'my_secret';
    const client1 = getLarkClient(appId, secret);
    const client2 = getLarkClient(appId, secret);
    const client3 = getLarkClient(appId, secret);
    expect(client1).toBe(client2);
    expect(client2).toBe(client3);
  });

  it('appSecretHash is stable for same secret', () => {
    const appId = 'cli_test_app_hash';
    const secret = 'stable_secret_value';
    const c1 = getLarkClient(appId, secret);
    const c2 = getLarkClient(appId, secret);
    expect(c1.appSecretHash).toBe(c2.appSecretHash);
    expect(c1.appSecretHash.length).toBe(64); // SHA-256 hex
  });

  it('different secrets produce different hashes', () => {
    const c1 = getLarkClient('cli_a', 'secret_one');
    const c2 = getLarkClient('cli_b', 'secret_two');
    expect(c1.appSecretHash).not.toBe(c2.appSecretHash);
  });
});

// ── E03: invalidateChatModeCache ──────────────────────────────────────

describe('chat mode cache (E03)', () => {
  it('invalidateChatModeCache removes cached entry', () => {
    const appId = 'cli_e03_test';
    const client = getLarkClient(appId, 'secret_e03');

    // Pre-populate the cache (access private field for test inspection)
    const cache = (client as any).chatModeCache as Map<string, { mode: string; cachedAt: number }>;
    const cacheKey = `${appId}::chat_abc`;
    cache.set(cacheKey, { mode: 'group', cachedAt: Date.now() });
    expect(cache.has(cacheKey)).toBe(true);

    client.invalidateChatModeCache('chat_abc');
    expect(cache.has(cacheKey)).toBe(false);
  });

  it('invalidateChatModeCache does not affect other chatIds', () => {
    const appId = 'cli_e03b_test';
    const client = getLarkClient(appId, 'secret_e03b');

    const cache = (client as any).chatModeCache as Map<string, { mode: string; cachedAt: number }>;
    const key1 = `${appId}::chat_a`;
    const key2 = `${appId}::chat_b`;
    cache.set(key1, { mode: 'group', cachedAt: Date.now() });
    cache.set(key2, { mode: 'topic', cachedAt: Date.now() });

    client.invalidateChatModeCache('chat_a');
    expect(cache.has(key1)).toBe(false);
    expect(cache.has(key2)).toBe(true); // chat_b unaffected
  });

  it('invalidateChatModeCache is idempotent (no-op on missing entry)', () => {
    const client = getLarkClient('cli_e03c_test', 'secret_e03c');
    // Should not throw when chatId not in cache
    expect(() => client.invalidateChatModeCache('nonexistent_chat')).not.toThrow();
  });
});

// ── E06: Token cache expiry (60s margin) ──────────────────────────────

describe('token cache expiry (E06)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refetches token when within 60s expiry margin', async () => {
    const appId = 'cli_e06_test';
    const client = getLarkClient(appId, 'secret_e06');

    let tokenFetchCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      if (urlStr.includes('auth/v3/tenant_access_token')) {
        tokenFetchCount++;
        return {
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: `tok-${tokenFetchCount}`, expire: 7200 }),
        } as Response;
      }
      if (urlStr.includes('bot/v3/info')) {
        return {
          ok: true,
          json: async () => ({ code: 0, bot: { open_id: 'ou_test', app_name: 'TestBot' } }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    try {
      // First call — fetches token
      await client.getBotOpenId();
      expect(tokenFetchCount).toBe(1);

      // Second call — uses cached token (fresh)
      await client.getBotOpenId();
      expect(tokenFetchCount).toBe(1);

      // Set expiresAt to 30s from now → within 60s margin → should refetch
      // Condition: Date.now() < expiresAt - 60_000
      // expiresAt = now + 30s → expiresAt - 60s = now - 30s
      // Date.now() < now - 30s → false → refetches
      (client as any).tokenCache.expiresAt = Date.now() + 30_000;

      await client.getBotOpenId();
      expect(tokenFetchCount).toBe(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('uses cached token when well outside expiry margin', async () => {
    const appId = 'cli_e06b_test';
    const client = getLarkClient(appId, 'secret_e06b');

    let tokenFetchCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      if (urlStr.includes('auth/v3/tenant_access_token')) {
        tokenFetchCount++;
        return {
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: `tok-${tokenFetchCount}`, expire: 7200 }),
        } as Response;
      }
      if (urlStr.includes('bot/v3/info')) {
        return {
          ok: true,
          json: async () => ({ code: 0, bot: { open_id: 'ou_test', app_name: 'TestBot' } }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    try {
      // First call — fetches token
      await client.getBotOpenId();
      expect(tokenFetchCount).toBe(1);

      // Set expiresAt to 90s from now → well outside 60s margin
      // Condition: Date.now() < expiresAt - 60_000
      // expiresAt = now + 90s → expiresAt - 60s = now + 30s
      // Date.now() < now + 30s → true → uses cached
      (client as any).tokenCache.expiresAt = Date.now() + 90_000;

      await client.getBotOpenId();
      expect(tokenFetchCount).toBe(1); // still using cached token
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ── E07: bot1 token expired → only bot1 refetches ─────────────────────

describe('bot token isolation (E07)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('expired token on one bot does not affect other bot cache', async () => {
    const client1 = getLarkClient('cli_bot1', 'secret1');
    const client2 = getLarkClient('cli_bot2', 'secret2');

    const tokenCalls = new Map<string, number>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      if (urlStr.includes('auth/v3/tenant_access_token')) {
        // Extract app_id from the request body
        let appId = 'unknown';
        try {
          const body = JSON.parse((options as any)?.body ?? '{}');
          appId = body.app_id;
        } catch { /* use 'unknown' */ }
        tokenCalls.set(appId, (tokenCalls.get(appId) || 0) + 1);
        return {
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: `tok-${appId}-v${tokenCalls.get(appId)}`, expire: 7200 }),
        } as Response;
      }
      if (urlStr.includes('bot/v3/info')) {
        return {
          ok: true,
          json: async () => ({ code: 0, bot: { open_id: 'ou_test', app_name: 'TestBot' } }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    try {
      // Prime both caches
      await client1.getBotOpenId();
      await client2.getBotOpenId();
      expect(tokenCalls.get('cli_bot1')).toBe(1);
      expect(tokenCalls.get('cli_bot2')).toBe(1);

      // Expire only bot1's token
      (client1 as any).tokenCache.expiresAt = Date.now() - 1000;

      // Call bot1 — should refetch
      await client1.getBotOpenId();
      expect(tokenCalls.get('cli_bot1')).toBe(2);

      // Call bot2 — should use cached token (unchanged)
      await client2.getBotOpenId();
      expect(tokenCalls.get('cli_bot2')).toBe(1);

      // Call bot1 again — should use fresh cached token
      await client1.getBotOpenId();
      expect(tokenCalls.get('cli_bot1')).toBe(2); // no additional refetch
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
