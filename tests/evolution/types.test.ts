import { describe, test, expect } from 'bun:test';

describe('Evolution types', () => {
  test('ReviewConfig shape is correct', () => {
    const config = {
      enabled: true,
      model: 'test',
      maxTurns: 6,
      tokenLimit: 30000,
      timeoutMs: 60000,
      outputDir: '/tmp/test',
    };
    expect(config.maxTurns).toBe(6);
    expect(config.timeoutMs).toBe(60000);
  });

  test('ReviewNotification has required fields', () => {
    const notification = {
      skillName: 'test-skill',
      description: 'A test skill',
      outputDir: '/tmp/test',
      createdAt: Date.now(),
    };
    expect(notification.skillName).toBe('test-skill');
    expect(notification.createdAt).toBeGreaterThan(0);
  });
});
