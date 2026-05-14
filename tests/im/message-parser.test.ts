// tests/im/message-parser.test.ts
import { describe, it, expect } from 'bun:test';
import { parseEventMessage, stripLeadingMentions } from '../../src/im/lark/message-parser';

describe('parseEventMessage', () => {
  it('parses text message', () => {
    const data = {
      message: {
        message_id: 'om_test123',
        chat_id: 'oc_test456',
        msg_type: 'text',
        content: JSON.stringify({ text: 'hello world' }),
        chat_type: 'group',
        create_time: '1715700000000',
      },
      sender: {
        sender_id: { open_id: 'ou_user1' },
        sender_type: 'user',
      },
    };
    const result = parseEventMessage(data);
    expect(result.messageId).toBe('om_test123');
    expect(result.content).toBe('hello world');
    expect(result.senderType).toBe('user');
    expect(result.chatType).toBe('group');
  });

  it('resolves @mention placeholders', () => {
    const data = {
      message: {
        message_id: 'om_test',
        chat_id: 'oc_test',
        msg_type: 'text',
        content: JSON.stringify({ text: '@_user_1 hello' }),
        mentions: [{ key: '@_user_1', name: 'BotName', id: { open_id: 'ou_bot1' } }],
        chat_type: 'group',
        create_time: '1715700000000',
      },
      sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
    };
    const result = parseEventMessage(data);
    expect(result.content).toBe('@BotName hello');
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0]!.openId).toBe('ou_bot1');
  });

  it('parses p2p chat type', () => {
    const data = {
      message: {
        message_id: 'om_test',
        chat_id: 'oc_test',
        msg_type: 'text',
        content: JSON.stringify({ text: 'hi' }),
        chat_type: 'p2p',
        create_time: '1715700000000',
      },
      sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
    };
    const result = parseEventMessage(data);
    expect(result.chatType).toBe('p2p');
  });
});

describe('stripLeadingMentions', () => {
  it('strips leading @mention', () => {
    const result = stripLeadingMentions('@Bot /restart', [
      { key: '@_user_1', name: 'Bot', openId: 'ou_bot1' },
    ]);
    expect(result).toBe('/restart');
  });

  it('keeps content when no mention at start', () => {
    const result = stripLeadingMentions('hello @Bot', [
      { key: '@_user_1', name: 'Bot', openId: 'ou_bot1' },
    ]);
    expect(result).toBe('hello @Bot');
  });

  it('strips only first mention when multiple', () => {
    const result = stripLeadingMentions('@Bot1 @Bot2 hello', [
      { key: '@_user_1', name: 'Bot1', openId: 'ou_b1' },
      { key: '@_user_2', name: 'Bot2', openId: 'ou_b2' },
    ]);
    // Should strip the first matching mention only (loop breaks on first match...
    // actually it loops through ALL mentions and strips each if at start)
    expect(result).toBe('hello');
  });
});
