import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SqliteMemoryStore } from '../../src/memory/sqlite-store';
import { KeywordRetriever } from '../../src/memory/retriever';
import { BM25Retriever } from '../../src/memory/bm25-retriever';
import { HybridRetriever } from '../../src/memory/hybrid-retriever';
import fs from 'node:fs';

const TEST_DB = '/tmp/memory.db';

function cleanDb() {
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}
}

describe('Hybrid retrieval full flow', () => {
  beforeEach(cleanDb);
  afterEach(cleanDb);

  const storeConfig = { globalBaseDir: '/tmp' };

  async function setup() {
    const semanticStore = new SqliteMemoryStore('semantic', storeConfig);
    const episodicStore = new SqliteMemoryStore('episodic', storeConfig);
    const projectStore = new SqliteMemoryStore('project', storeConfig);
    const hybrid = new HybridRetriever(
      new KeywordRetriever(semanticStore, episodicStore, projectStore),
      new BM25Retriever(semanticStore, episodicStore, projectStore),
      { search: async () => [] } as any, // Vector mock
    );

    await semanticStore.add({
      type: 'semantic',
      text: '用户偏好使用 pnpm 而非 npm',
      tags: ['pnpm', 'preference'],
      weight: 1,
      source: 'explicit',
    });
    await semanticStore.add({
      type: 'semantic',
      text: '项目使用 TypeScript 和 Bun 运行时',
      tags: ['typescript', 'bun'],
      weight: 0.9,
      source: 'implicit',
    });
    await episodicStore.add({
      type: 'episodic',
      text: '修复了 pnpm install 的 bug',
      tags: ['bug', 'pnpm'],
      weight: 0.7,
      source: 'implicit',
    });

    return hybrid;
  }

  it('keyword + BM25 combined find correct results', async () => {
    const hybrid = await setup();
    const results = await hybrid.search('pnpm');
    expect(results.length).toBeGreaterThanOrEqual(1);
    const texts = results.map(r => r.text);
    expect(texts.some(t => t.includes('pnpm'))).toBe(true);
  });

  it('Chinese text search works', async () => {
    const hybrid = await setup();
    const results = await hybrid.search('用户偏好');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].text).toContain('用户偏好');
  });

  it('limit restricts result count', async () => {
    const hybrid = await setup();
    const results = await hybrid.search('pnpm', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('returns empty for no match', async () => {
    const hybrid = await setup();
    const results = await hybrid.search('zzz_nonexistent_query');
    expect(results).toHaveLength(0);
  });
});
