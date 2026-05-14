// src/im/types.ts
import type { Session } from '../types';

export interface RoutingContext {
  chatId: string;
  messageId: string;
  chatType: 'group' | 'p2p';
  scope: 'thread' | 'chat';
  anchor: string;
  larkAppId: string;
}

export interface FrozenCard {
  messageId: string;
  content: string;
  title: string;
  displayMode: 'hidden' | 'markdown';
}

export interface DaemonSession {
  session: Session;
  larkAppId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  scope: 'thread' | 'chat';
  spawnedAt: number;
  lastMessageAt: number;
  hasHistory: boolean;
  workingDir?: string;
  pendingPrompt?: string;
  streamCardId?: string;
  streamCardNonce?: string;
  lastScreenContent?: string;
  currentTurnTitle?: string;
  cardPatchInFlight?: boolean;
  pendingCardJson?: string;
  frozenCards?: Map<string, FrozenCard>;
  busy: boolean;
  messageQueue: string[];
  ownerOpenId?: string;
}

export function sessionKey(anchor: string, larkAppId: string): string {
  return `${anchor}::${larkAppId}`;
}

export function sessionAnchorId(ds: DaemonSession): string {
  return ds.scope === 'chat' ? ds.chatId : ds.session.rootMessageId;
}
