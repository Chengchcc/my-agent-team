import { describe, test, expect } from 'bun:test';
import { initEvolution } from '../../src/evolution';
import type { ReviewConfig } from '../../src/evolution/types';

const disabledConfig: ReviewConfig = {
  enabled: false, model: 'test', maxTurns: 1, tokenLimit: 1000, timeoutMs: 5000, outputDir: '/tmp',
};

describe('Evolution TUI decoupling', () => {
  test('initEvolution returns null when disabled', () => {
    const result = initEvolution(disabledConfig, {} as any);
    expect(result).toBeNull();
  });

  test('initEvolution accepts notify callback without TUI dependency', () => {
    const notifications: Array<{ skillName: string; description: string; outputDir: string }> = [];
    const notify = (skillName: string, description: string, outputDir: string) => {
      notifications.push({ skillName, description, outputDir });
    };
    const result = initEvolution(
      { enabled: true, model: 'test', maxTurns: 1, tokenLimit: 1000, timeoutMs: 5000, outputDir: '/tmp/evolution-test' },
      {} as any,
      notify,
    );
    expect(result).not.toBeNull();
  });

  test('evolution module does not import TUI store', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(require.resolve('../../src/evolution/index.ts'), 'utf-8'),
    );
    expect(source).not.toContain('useTuiStore');
  });
});
