// src/extensions/frontend.lark/lark/types.ts
import type { Session } from '../../../domain/session/types';

export interface RoutingContext {
  chatId: string;
  messageId: string;
  chatType: 'group' | 'p2p';
  scope: 'thread' | 'chat' | 'p2p';
  anchor: string;
  /** The thread's root message_id. Falls back to messageId when not in a thread. */
  threadRootId: string;
  larkAppId: string;
}

export interface FrozenCard {
  messageId: string;
  content: string;
  title: string;
  displayMode: 'hidden' | 'markdown';
}

/** @public — consumed by Lark bot adapter internals */
export interface DaemonSession {
  session: Session;
  larkAppId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  scope: 'thread' | 'chat' | 'p2p';
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

