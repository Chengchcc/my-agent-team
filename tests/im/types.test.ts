import { describe, it, expect } from 'bun:test';
import { sessionKey, sessionAnchorId, type DaemonSession } from '../../src/im/types';

describe('sessionKey', () => {
  it('creates composite key from anchor and appId', () => {
    const key = sessionKey('om_thread123', 'cli_app456');
    expect(key).toBe('om_thread123::cli_app456');
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
});
