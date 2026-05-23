import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { atomicWrite, atomicRead, atomicDelete } from '../../src/shared/atomic-write';
import { unlinkSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'lobster-test-atomic');
mkdirSync(TEST_DIR, { recursive: true });

describe('atomic-write', () => {
  beforeEach(() => {
    try { unlinkSync(join(TEST_DIR, 'test.txt')); } catch {}
    try { unlinkSync(join(TEST_DIR, 'test.txt.tmp')); } catch {}
    try { unlinkSync(join(TEST_DIR, 'nonexistent.txt')); } catch {}
    try { unlinkSync(join(TEST_DIR, 'nonexistent.txt.tmp')); } catch {}
  });

  it('should write file atomically', async () => {
    const path = join(TEST_DIR, 'test.txt');
    await atomicWrite(path, 'hello world');
    expect(readFileSync(path, 'utf8')).toBe('hello world');
  });

  it('should read file with fallback', async () => {
    const path = join(TEST_DIR, 'nonexistent.txt');
    const result = await atomicRead(path, 'default');
    expect(result).toBe('default');

    await atomicWrite(path, 'content');
    const result2 = await atomicRead(path, 'default');
    expect(result2).toBe('content');
  });

  it('should delete file atomically', async () => {
    const path = join(TEST_DIR, 'test.txt');
    await atomicWrite(path, 'hello');
    expect(existsSync(path)).toBe(true);

    await atomicDelete(path);
    expect(existsSync(path)).toBe(false);
  });

  it('should not leave temp file on success', async () => {
    const path = join(TEST_DIR, 'test.txt');
    await atomicWrite(path, 'hello');
    expect(existsSync(path + '.tmp')).toBe(false);
  });
});
