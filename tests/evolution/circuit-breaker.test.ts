import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CircuitBreaker } from '../../src/evolution/circuit-breaker';

const TEST_PATH = path.join(os.tmpdir(), `breaker-test-${Date.now()}.json`);

describe('CircuitBreaker', () => {
  afterEach(async () => { await fs.rm(TEST_PATH, { force: true }).catch(() => {}); });

  test('starts closed', () => {
    expect(new CircuitBreaker(TEST_PATH).canRun()).toBe(true);
  });

  test('opens after 3 consecutive failures', () => {
    const breaker = new CircuitBreaker(TEST_PATH);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.canRun()).toBe(false);
  });

  test('resets on success', () => {
    const breaker = new CircuitBreaker(TEST_PATH);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.canRun()).toBe(true);
    expect(breaker.failures).toBe(0);
  });
});
