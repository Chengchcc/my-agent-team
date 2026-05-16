import { describe, it, expect } from 'bun:test';
import { sessionKey, sessionAnchorId, type DaemonSession } from '../../src/im/types';

describe('sessionKey', () => {
  it('creates composite key from anchor and appId', () => {
    const key = sessionKey('om_thread123', 'cli_app456');
    expect(key).toBe('om_thread123\x1fcli_app456');
  });
});

describe('sessionAnchorId', () => {
  it('returns chatId for chat-scope sessions', () => {
    const ds: DaemonSession = {
      session: { id: 's1', rootMessageId: 'om_root', createdAt: '', updatedAt: '' },
      larkAppId: 'app1',
      chatId: 'oc_chat123',
      chatType: 'group',
      scope: 'chat',
      spawnedAt: Date.now(),
      lastMessageAt: Date.now(),
      hasHistory: false,
      busy: false,
      messageQueue: [],
    };
    expect(sessionAnchorId(ds)).toBe('oc_chat123');
  });

  it('returns rootMessageId for thread-scope sessions', () => {
    const ds: DaemonSession = {
      session: { id: 's1', rootMessageId: 'om_root456', createdAt: '', updatedAt: '' },
      larkAppId: 'app1',
      chatId: 'oc_chat123',
      chatType: 'group',
      scope: 'thread',
      spawnedAt: Date.now(),
      lastMessageAt: Date.now(),
      hasHistory: false,
      busy: false,
      messageQueue: [],
    };
    expect(sessionAnchorId(ds)).toBe('om_root456');
  });

  it('never produces a key containing the string "undefined"', () => {
    const ds: DaemonSession = {
      session: { id: 's1', rootMessageId: 'om_root456', createdAt: '', updatedAt: '' },
      larkAppId: 'app1',
      chatId: 'oc_chat123',
      chatType: 'group',
      scope: 'thread',
      spawnedAt: Date.now(),
      lastMessageAt: Date.now(),
      hasHistory: false,
      busy: false,
      messageQueue: [],
    };
    const anchor = sessionAnchorId(ds);
    // sessionAnchorId returns chatId or rootMessageId, never 'undefined'
    expect(anchor).not.toContain('undefined');
    expect(typeof anchor).toBe('string');
    expect(anchor.length).toBeGreaterThan(0);
  });
});

describe('sessionKey edge cases', () => {
  it('uses \\x1f separator (unit separator), not "::"', () => {
    const key = sessionKey('anchor_with::colons', 'app');
    // The key contains the anchor as-is, separated by \x1f
    expect(key).toContain('\x1f');
    expect(key).toBe('anchor_with::colons\x1fapp');
  });

  it('never produces "undefined" substring even with edge inputs', () => {
    const key = sessionKey('chat_123', 'lark_app_456');
    expect(key).not.toContain('undefined');
  });
});
