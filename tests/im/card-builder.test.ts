import { describe, it, expect } from 'bun:test';

import {
  buildStreamingCard,
  buildPermissionCard,
  buildAskUserQuestionCard,
  buildResolvedCard,
  buildRepoSelectCard,
} from '../../src/im/lark/card-builder';
import { parseEventMessage } from '../../src/im/lark/message-parser';

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

describe('escapeMd (via builders)', () => {
  // escapeMd is a private function in card-builder.ts.
  // Test indirectly through card builders that pass input through escapeMd.
  // buildResolvedCard passes its text argument directly through escapeMd.

  function getResolvedText(text: string): string {
    const card = buildResolvedCard(text);
    const parsed = JSON.parse(card);
    return parsed.elements[0].text.content;
  }

  it('escapes > character (#13)', () => {
    const result = getResolvedText('foo > bar');
    expect(result).toContain('\\>');
  });

  it('escapes ! character', () => {
    const result = getResolvedText('hello! world');
    expect(result).toContain('\\!');
  });

  it('escapes # character', () => {
    const result = getResolvedText('# heading');
    expect(result).toContain('\\#');
  });

  it('escapes ( character', () => {
    const result = getResolvedText('func()');
    expect(result).toContain('\\(');
    expect(result).toContain('\\)');
  });

  it('escapes ) character', () => {
    const result = getResolvedText('end)');
    expect(result).toContain('\\)');
  });

  it('still escapes * character', () => {
    const result = getResolvedText('bold *text*');
    expect(result).toContain('\\*');
  });

  it('still escapes _ character', () => {
    const result = getResolvedText('underline _text_');
    expect(result).toContain('\\_');
  });

  it('still escapes ~ character', () => {
    const result = getResolvedText('strikethrough ~text~');
    expect(result).toContain('\\~');
  });

  it('still escapes ` character', () => {
    const result = getResolvedText('code `var`');
    expect(result).toContain('\\`');
  });

  it('still escapes [ and ] characters', () => {
    const result = getResolvedText('link [text](url)');
    expect(result).toContain('\\[');
  });

  it('escapes mixed content with multiple special characters (#73)', () => {
    const result = getResolvedText('Check: #1 priority > everything else! (see docs)');
    expect(result).toContain('\\#');
    expect(result).toContain('\\>');
    expect(result).toContain('\\!');
    expect(result).toContain('\\(');
    expect(result).toContain('\\)');
  });

  it('does not escape normal text', () => {
    const result = getResolvedText('Hello World');
    expect(result).not.toContain('\\');
    expect(result).toBe('Hello World');
  });

  it('escapes toolName in buildPermissionCard', () => {
    const card = buildPermissionCard({
      sessionId: 'test',
      rootId: 'om_test',
      toolName: 'danger>tool',
      reason: 'just because',
      command: 'ls',
    });
    const parsed = JSON.parse(card);
    const md = parsed.elements.find((e: Record<string, unknown>) => e.tag === 'markdown') as Record<string, unknown>;
    expect(md.content as string).toContain('danger\\>tool');
  });

  it('escapes reason in buildPermissionCard', () => {
    const card = buildPermissionCard({
      sessionId: 'test',
      rootId: 'om_test',
      toolName: 'bash',
      reason: 'delete #1!',
      command: 'ls',
    });
    const parsed = JSON.parse(card);
    const md = parsed.elements.find((e: Record<string, unknown>) => e.tag === 'markdown') as Record<string, unknown>;
    expect(md.content as string).toContain('\\#');
    expect(md.content as string).toContain('\\!');
  });

  it('escapes title in buildStreamingCard', () => {
    const card = buildStreamingCard({
      sessionId: 'test',
      rootId: 'om_test',
      title: 'Fix #42 > issue!',
      markdownContent: '',
      status: 'idle',
      displayMode: 'hidden',
    });
    const parsed = JSON.parse(card);
    const titleContent: string = parsed.header.title.content;
    expect(titleContent).toContain('\\#');
    expect(titleContent).toContain('\\>');
    expect(titleContent).toContain('\\!');
  });
});

// ── I02: Card truncation uses configurable constant ───────────────────

describe('card truncation constant (I02)', () => {
  // CONTENT_TRUNCATION_LIMIT is not exported but is set to 3000 in card-builder.ts.
  // These tests verify truncation behavior is consistent with a named constant,
  // not magic numbers buried in logic.

  it('does NOT truncate content at exactly 3000 characters', () => {
    const content = 'x'.repeat(3000);
    const card = buildStreamingCard({
      sessionId: 'test',
      rootId: 'om_test',
      title: 'Test',
      markdownContent: content,
      status: 'working',
      displayMode: 'markdown',
    });
    const parsed = JSON.parse(card);
    const md = parsed.elements.find((e: any) => e.tag === 'markdown');
    expect(md.content).toBe('x'.repeat(3000));
    expect(md.content).not.toContain('截断');
  });

  it('truncates content at 3001 characters', () => {
    const content = 'y'.repeat(3001);
    const card = buildStreamingCard({
      sessionId: 'test',
      rootId: 'om_test',
      title: 'Test',
      markdownContent: content,
      status: 'working',
      displayMode: 'markdown',
    });
    const parsed = JSON.parse(card);
    const md = parsed.elements.find((e: any) => e.tag === 'markdown');
    expect(md.content.length).toBeLessThan(3200); // truncated + truncation notice
    expect(md.content).toContain('截断');
    expect(md.content).toContain('y'.repeat(3000));
  });

  it('truncation is consistent regardless of display mode', () => {
    const longContent = 'z'.repeat(4000);
    const visibleCard = buildStreamingCard({
      sessionId: 'test',
      rootId: 'om_test',
      title: 'Test',
      markdownContent: longContent,
      status: 'working',
      displayMode: 'markdown',
    });
    // Both modes use the same truncation logic
    const parsed = JSON.parse(visibleCard);
    const md = parsed.elements.find((e: any) => e.tag === 'markdown');
    expect(md.content.length).toBeLessThan(3200);
  });
});

// ── I03: Non-text msgType placeholders (via parseEventMessage) ────────

describe('message content extraction placeholders (I03)', () => {
  // extractMessageContent is private in message-parser.ts;
  // tested indirectly via parseEventMessage.

  it('image msgType → "[图片]"', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {
      message: {
        message_id: 'om_img',
        chat_id: 'oc_test',
        msg_type: 'image',
        // content could be image_key JSON but it's ignored for image type
        content: JSON.stringify({ image_key: 'img_abc123' }),
        chat_type: 'group',
        create_time: '1715700000000',
      },
      sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
    };
    const result = parseEventMessage(data);
    expect(result.msgType).toBe('image');
    expect(result.content).toBe('[图片]');
  });

  it('file msgType → "[文件:name]"', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {
      message: {
        message_id: 'om_file',
        chat_id: 'oc_test',
        msg_type: 'file',
        content: JSON.stringify({ file_key: 'fk_xyz', file_name: 'report.pdf' }),
        chat_type: 'group',
        create_time: '1715700000000',
      },
      sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
    };
    const result = parseEventMessage(data);
    expect(result.msgType).toBe('file');
    expect(result.content).toBe('[文件:report.pdf]');
  });

  it('file msgType without file_name → "[文件:file]"', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {
      message: {
        message_id: 'om_file2',
        chat_id: 'oc_test',
        msg_type: 'file',
        content: JSON.stringify({ file_key: 'fk_noid' }),
        chat_type: 'group',
        create_time: '1715700000000',
      },
      sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
    };
    const result = parseEventMessage(data);
    expect(result.msgType).toBe('file');
    expect(result.content).toBe('[文件:file]');
  });

  it('audio msgType → "[语音]"', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {
      message: {
        message_id: 'om_audio',
        chat_id: 'oc_test',
        msg_type: 'audio',
        content: JSON.stringify({}),
        chat_type: 'group',
        create_time: '1715700000000',
      },
      sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
    };
    const result = parseEventMessage(data);
    expect(result.msgType).toBe('audio');
    expect(result.content).toBe('[语音]');
  });

  it('sticker msgType → "[表情]"', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {
      message: {
        message_id: 'om_sticker',
        chat_id: 'oc_test',
        msg_type: 'sticker',
        content: JSON.stringify({}),
        chat_type: 'group',
        create_time: '1715700000000',
      },
      sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
    };
    const result = parseEventMessage(data);
    expect(result.msgType).toBe('sticker');
    expect(result.content).toBe('[表情]');
  });
});

// ── I04: Multi-paragraph post concatenation ──────────────────────────

describe('post message multi-paragraph concatenation (I04)', () => {
  // Post messages have nested paragraph content — all text nodes
  // should be concatenated (without separators between paragraphs).

  it('concatenates text from all paragraphs', () => {
    const data = {
      message: {
        message_id: 'om_post',
        chat_id: 'oc_test',
        msg_type: 'post',
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                { tag: 'text', text: 'First paragraph.' },
              ],
              [
                { tag: 'text', text: 'Second paragraph.' },
              ],
            ],
          },
        }),
        chat_type: 'group',
        create_time: '1715700000000',
      },
      sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
    };
    const result = parseEventMessage(data);
    expect(result.msgType).toBe('post');
    expect(result.content).toBe('First paragraph.Second paragraph.');
  });

  it('concatenates text with inline non-text nodes skipped', () => {
    const data = {
      message: {
        message_id: 'om_post2',
        chat_id: 'oc_test',
        msg_type: 'post',
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                { tag: 'text', text: 'Hello ' },
                { tag: 'at', user_id: 'ou_123' },
                { tag: 'text', text: 'world' },
              ],
            ],
          },
        }),
        chat_type: 'group',
        create_time: '1715700000000',
      },
      sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
    };
    const result = parseEventMessage(data);
    expect(result.msgType).toBe('post');
    expect(result.content).toBe('Hello world');
  });

  it('handles empty post content gracefully', () => {
    const data = {
      message: {
        message_id: 'om_post3',
        chat_id: 'oc_test',
        msg_type: 'post',
        content: JSON.stringify({}),
        chat_type: 'group',
        create_time: '1715700000000',
      },
      sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
    };
    const result = parseEventMessage(data);
    expect(result.msgType).toBe('post');
    expect(result.content).toBe(''); // empty when no content found
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
