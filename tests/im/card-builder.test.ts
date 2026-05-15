import { describe, it, expect } from 'bun:test';
import { buildStreamingCard, buildResolvedCard } from '../../src/im/lark/card-builder';

describe('buildStreamingCard', () => {
  it('produces valid JSON with status header and markdown', () => {
    const card = buildStreamingCard({
      title: 'Test',
      markdownContent: 'Hello **world**',
      status: 'working',
    });
    const parsed = JSON.parse(card);
    expect(parsed.header.template).toBe('blue');
    expect(parsed.config.wide_screen_mode).toBe(true);
    const md = parsed.elements.find((e: any) => e.tag === 'markdown');
    expect(md.content).toContain('Hello');
  });

  it('truncates content over 3000 characters', () => {
    const card = buildStreamingCard({
      title: 'Test',
      markdownContent: 'x'.repeat(4000),
      status: 'working',
    });
    const parsed = JSON.parse(card);
    const md = parsed.elements.find((e: any) => e.tag === 'markdown');
    expect(md.content.length).toBeLessThan(3200);
    expect(md.content).toContain('截断');
  });

  it('uses correct status template for each state', () => {
    const states = [
      { status: 'starting' as const, template: 'yellow' },
      { status: 'working' as const, template: 'blue' },
      { status: 'idle' as const, template: 'green' },
    ];
    for (const { status, template } of states) {
      const card = buildStreamingCard({ title: 'Test', markdownContent: '', status });
      expect(JSON.parse(card).header.template).toBe(template);
    }
  });
});

describe('buildResolvedCard', () => {
  it('produces a resolved card', () => {
    const card = buildResolvedCard('Done');
    const parsed = JSON.parse(card);
    expect(parsed.header.template).toBe('green');
  });
});
