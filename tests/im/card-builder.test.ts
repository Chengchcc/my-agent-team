import { describe, it, expect } from 'bun:test';

import {
  buildStreamingCard,
  buildPermissionCard,
  buildAskUserQuestionCard,
  buildResolvedCard,
  buildRepoSelectCard,
} from '../../src/im/lark/card-builder';

describe('buildStreamingCard', () => {
  it('produces valid JSON with correct structure', () => {
    const card = buildStreamingCard({
      sessionId: 'test-session',
      rootId: 'om_test',
      title: 'Test Title',
      markdownContent: 'Hello **world**',
      status: 'working',
      displayMode: 'markdown',
    });
    const parsed = JSON.parse(card);
    expect(parsed.header.template).toBe('blue');
    expect(parsed.config.wide_screen_mode).toBe(true);
    expect(parsed.elements).toBeDefined();
  });

  it('hides markdown content when displayMode is hidden', () => {
    const card = buildStreamingCard({
      sessionId: 'test',
      rootId: 'om_test',
      title: 'Test',
      markdownContent: 'secret content',
      status: 'idle',
      displayMode: 'hidden',
    });
    const parsed = JSON.parse(card);
    const markdownElements = parsed.elements.filter((e: any) => e.tag === 'markdown');
    expect(markdownElements).toHaveLength(0);
  });

  it('shows markdown content when displayMode is markdown', () => {
    const card = buildStreamingCard({
      sessionId: 'test',
      rootId: 'om_test',
      title: 'Test',
      markdownContent: 'visible content',
      status: 'working',
      displayMode: 'markdown',
    });
    const parsed = JSON.parse(card);
    const markdownElements = parsed.elements.filter((e: any) => e.tag === 'markdown');
    expect(markdownElements).toHaveLength(1);
    expect(markdownElements[0].content).toContain('visible content');
  });

  it('truncates content over 3000 characters', () => {
    const longContent = 'x'.repeat(4000);
    const card = buildStreamingCard({
      sessionId: 'test',
      rootId: 'om_test',
      title: 'Test',
      markdownContent: longContent,
      status: 'working',
      displayMode: 'markdown',
    });
    const parsed = JSON.parse(card);
    const md = parsed.elements.find((e: any) => e.tag === 'markdown');
    expect(md.content.length).toBeLessThan(3200);
    expect(md.content).toContain('截断');
  });

  it('includes all action buttons', () => {
    const card = buildStreamingCard({
      sessionId: 'test',
      rootId: 'om_test',
      title: 'Test',
      markdownContent: '',
      status: 'idle',
      displayMode: 'hidden',
    });
    const parsed = JSON.parse(card);
    const actionEl = parsed.elements.find((e: any) => e.tag === 'action');
    expect(actionEl).toBeDefined();
    expect(actionEl.actions).toHaveLength(3); // toggle, restart, close
  });

  it('uses correct status template for each state', () => {
    const states = [
      { status: 'starting' as const, template: 'yellow' },
      { status: 'working' as const, template: 'blue' },
      { status: 'idle' as const, template: 'green' },
      { status: 'analyzing' as const, template: 'purple' },
      { status: 'error' as const, template: 'red' },
    ];
    for (const { status, template } of states) {
      const card = buildStreamingCard({
        sessionId: 'test',
        rootId: 'om_test',
        title: 'Test',
        markdownContent: '',
        status,
        displayMode: 'hidden',
      });
      const parsed = JSON.parse(card);
      expect(parsed.header.template).toBe(template);
    }
  });
});

describe('buildPermissionCard', () => {
  it('produces card with allow/deny/always buttons', () => {
    const card = buildPermissionCard({
      sessionId: 'test',
      rootId: 'om_test',
      toolName: 'bash',
      reason: 'destructive deletion',
      command: 'rm -rf dist',
    });
    const parsed = JSON.parse(card);
    expect(parsed.header.template).toBe('yellow');
    const actions = parsed.elements.find((e: any) => e.tag === 'action');
    expect(actions.actions).toHaveLength(3);
    const labels = actions.actions.map((a: any) => a.text.content);
    expect(labels).toContain('✅ 允许');
    expect(labels).toContain('❌ 拒绝');
    expect(labels).toContain('🔓 始终允许');
  });

  it('truncates long commands', () => {
    const card = buildPermissionCard({
      sessionId: 'test',
      rootId: 'om_test',
      toolName: 'bash',
      reason: 'test',
      command: 'x'.repeat(200),
    });
    const parsed = JSON.parse(card);
    const md = parsed.elements.find((e: any) => e.tag === 'markdown');
    // Command should be truncated at 100 chars in the card display
    expect(md.content.length).toBeLessThan(300);
  });
});

describe('buildAskUserQuestionCard', () => {
  it('produces card with question buttons', () => {
    const card = buildAskUserQuestionCard({
      sessionId: 'test',
      rootId: 'om_test',
      header: 'Permission Required',
      questions: [
        {
          question: 'Proceed with deletion?',
          header: 'Confirm',
          options: [
            { label: 'Yes', description: 'Delete files' },
            { label: 'No', description: 'Cancel' },
          ],
        },
      ],
    });
    const parsed = JSON.parse(card);
    expect(parsed.header.template).toBe('blue');
    expect(parsed.header.title.content).toContain('Permission Required');
    const foundAction = parsed.elements.find((e: any) => e.tag === 'action');
    expect(foundAction).toBeDefined();
    expect(foundAction.actions).toHaveLength(2);
  });

  it('caps options at 4 per question', () => {
    const card = buildAskUserQuestionCard({
      sessionId: 'test',
      rootId: 'om_test',
      header: 'Choose',
      questions: [
        {
          question: 'Pick one',
          header: 'Options',
          options: [
            { label: 'A', description: 'Option A' },
            { label: 'B', description: 'Option B' },
            { label: 'C', description: 'Option C' },
            { label: 'D', description: 'Option D' },
            { label: 'E', description: 'Option E' },
            { label: 'F', description: 'Option F' },
          ],
        },
      ],
    });
    const parsed = JSON.parse(card);
    const foundAction = parsed.elements.find((e: any) => e.tag === 'action');
    expect(foundAction.actions.length).toBeLessThanOrEqual(4);
  });
});

describe('buildResolvedCard', () => {
  it('produces a simple resolved card', () => {
    const card = buildResolvedCard('Done');
    const parsed = JSON.parse(card);
    expect(parsed.header.template).toBe('green');
    expect(parsed.header.title.content).toContain('已处理');
  });
});

describe('buildRepoSelectCard', () => {
  it('produces a repo selection card with projects', () => {
    const projects = [
      { name: 'api', branch: 'main', path: '/tmp/api' },
      { name: 'web', branch: 'develop', path: '/tmp/web' },
    ];
    const card = buildRepoSelectCard(projects, 'om_root');
    const parsed = JSON.parse(card);
    expect(parsed.header.title.content).toContain('选择工作目录');
    const action = parsed.elements[0] as any;
    expect(action.tag).toBe('action');
    expect(action.actions).toHaveLength(2);
  });
});
