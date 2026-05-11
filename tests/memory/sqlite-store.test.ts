import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SqliteMemoryStore } from '../../src/memory/sqlite-store';
import type { MemoryEntry } from '../../src/memory/types';
import fs from 'node:fs';

const TEST_DB = '/tmp/memory.db';

function cleanDb() {
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}
}

describe('SqliteMemoryStore', () => {
  beforeEach(cleanDb);
  afterEach(cleanDb);

  const entryData = {
    type: 'general' as const,
    text: 'user prefers vitest over jest',
    tags: ['testing', 'vitest'],
    weight: 0.9,
    source: 'explicit' as const,
  };

  it('adds and retrieves an entry by id', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp' });
    const entry = await store.add(entryData);
    expect(entry.id).toBeDefined();
    expect(entry.text).toBe(entryData.text);
    expect(entry.tags).toEqual(['testing', 'vitest']);

    const retrieved = await store.get(entry.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.text).toBe(entryData.text);
  });

  it('returns null for missing id', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp' });
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  it('getAll returns all entries of the same type', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp' });
    await store.add({ ...entryData, text: 'fact 1' });
    await store.add({ ...entryData, text: 'fact 2' });

    const all = await store.getAll();
    expect(all).toHaveLength(2);
  });

  it('getAll returns all entries of the registered type', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp' });
    await store.add({ ...entryData, text: 'fact 1' });
    await store.add({ ...entryData, text: 'fact 2' });

    const all = await store.getAll();
    expect(all).toHaveLength(2);
  });

  it('updates an entry', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp' });
    const entry = await store.add(entryData);
    const updated = await store.update(entry.id, { text: 'updated text', weight: 0.5 });
    expect(updated).not.toBeNull();
    expect(updated!.text).toBe('updated text');
    expect(updated!.weight).toBe(0.5);
  });

  it('removes an entry', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp' });
    const entry = await store.add(entryData);
    const removed = await store.remove(entry.id);
    expect(removed).toBe(true);

    const all = await store.getAll();
    expect(all).toHaveLength(0);
  });

  it('count returns correct number', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp' });
    await store.add(entryData);
    await store.add(entryData);
    expect(await store.count()).toBe(2);
  });

  it('getRecent returns entries sorted by created desc', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp' });
    await store.add({ ...entryData, text: 'older' });
    await new Promise(r => setTimeout(r, 10));
    await store.add({ ...entryData, text: 'newer' });

    const recent = await store.getRecent(2);
    expect(recent[0].text).toBe('newer');
    expect(recent[1].text).toBe('older');
  });

  it('markHit updates lastHitAt and usageCount', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp' });
    const entry = await store.add(entryData);

    await store.markHit([entry.id]);
    const updated = await store.get(entry.id);
    expect(updated!.lastHitAt).toBeDefined();
    expect(updated!.usageCount).toBe(1);
  });

  it('enforceLimit evicts oldest entries', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp', maxGeneralEntries: 2 });
    await store.add({ ...entryData, text: 'entry 1' });
    await store.add({ ...entryData, text: 'entry 2' });
    await store.add({ ...entryData, text: 'entry 3' });

    expect(await store.count()).toBeLessThanOrEqual(2);
  });

  it('stores and retrieves embedding as number array', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp' });
    const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
    const entry = await store.add({ ...entryData, embedding });
    const retrieved = await store.get(entry.id);
    expect(retrieved!.embedding).toBeDefined();
    expect(retrieved!.embedding!.length).toBe(embedding.length);
    for (let i = 0; i < embedding.length; i++) {
      expect(retrieved!.embedding![i]).toBeCloseTo(embedding[i], 4);
    }
  });

  it('replaceAll replaces all entries', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp' });
    await store.add({ ...entryData, text: 'old' });
    const newEntries: MemoryEntry[] = [{
      id: 'manual-id',
      type: 'general',
      text: 'new',
      created: new Date().toISOString(),
      weight: 1,
      source: 'explicit',
    }];
    await store.replaceAll(newEntries, 'general');
    const all = await store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe('new');
  });

  it('FTS5: text stored in FTS5 is searchable', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp' });
    const e = await store.add({ ...entryData, text: 'user prefers pnpm over npm' });
    const results = await store.ftsSearch('pnpm', 'general', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(e.id);
  });

  it('FTS5: returns empty for no match', async () => {
    const store = new SqliteMemoryStore('general', { globalBaseDir: '/tmp' });
    await store.add({ ...entryData, text: 'user prefers pnpm' });
    const results = await store.ftsSearch('nonexistent', 'general', 10);
    expect(results).toHaveLength(0);
  });
});
