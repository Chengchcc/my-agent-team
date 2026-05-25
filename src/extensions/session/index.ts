import { defineExtension } from '../../kernel/define-extension'
import type { HookHandler } from '../../kernel/define-extension'
import { createEvent } from '../../application/contracts';
import { asContractBus } from '../../application/event-bus/contract-bus';
import { SqliteSessionStore } from '../../infrastructure/session/sqlite-session-store'
import { SqliteHistoryStore } from '../../infrastructure/session/sqlite-history-store'
import { openDb, runMigrations } from '../../infrastructure/_sqlite/connection'
import { sessionMigrations } from '../../infrastructure/session/sqlite-session-schema'
import { createSession } from '../../domain/session'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createTurn } from '../../domain/turn'
import { createTraceEventFactory } from '../../domain/trace-event'
import type { TraceEvent } from '../../domain/trace-event'
import { createCompactor } from './compactor'
import type { ProviderInvoke } from '../../application/ports/provider'
import type { HookContainer } from '../../kernel/hook-container'
import type { SessionStore } from '../../application/ports/session-store'

interface TurnStartDeps {
  sessionStore: SessionStore;
  eventFactory: ReturnType<typeof createTraceEventFactory>;
  hooks: HookContainer;
  contractBus: ReturnType<typeof asContractBus>;
}

function makeOnTurnStart(d: TurnStartDeps): HookHandler {
  return async (...args: unknown[]) => {
    const sessionId = args[0] as string;
    const frontendId = args[1] as string;
    const session = await d.sessionStore.load(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.startTurn(frontendId);
    await d.sessionStore.save(session);
    const turn = createTurn(`turn-${d.eventFactory.lastCursor + 1}`, sessionId);
    const traceEvt = d.eventFactory.next(turn.id, 'turn.started', { sessionId, frontendId });
    await d.hooks.dispatch('onTraceEmit', traceEvt);
    d.contractBus.emit(createEvent('turn.started', { sessionId, turnId: turn.id }, { sessionId, turnId: turn.id }));
    return turn;
  };
}

interface TurnEndDeps {
  sessionStore: SessionStore;
  eventFactory: ReturnType<typeof createTraceEventFactory>;
  hooks: HookContainer;
}

function makeOnTurnEnd(d: TurnEndDeps): HookHandler {
  return async (...args: unknown[]) => {
    const result = args[0] as { sessionId: string; turnId: string; usage?: { input: number; output: number } };
    const session = await d.sessionStore.load(result.sessionId);
    if (session) { session.completeTurn(); await d.sessionStore.save(session); }
    const traceEvt: TraceEvent = d.eventFactory.next(result.turnId, 'turn.completed', { tokens: result.usage });
    await d.hooks.dispatch('onTraceEmit', traceEvt);
  };
}

export default () =>
  defineExtension({
    name: 'session',
    enforce: 'normal',
    dependsOn: ['trace'],

    apply: (ctx) => {
      const contractBus = asContractBus(ctx.bus)
      mkdirSync(ctx.paths.sessions, { recursive: true })
      const db = openDb(join(ctx.paths.sessions, 'sessions.db'))
      runMigrations(db, sessionMigrations)
      const sessionStore = new SqliteSessionStore(db)
      const historyStore = new SqliteHistoryStore(db)
      const eventFactory = createTraceEventFactory()
      const abortControllers = new Map<string, AbortController>()

      const kernelReady: HookHandler = async () => {
        const existing = await sessionStore.load('main')
        if (!existing) {
          const mainSession = createSession('main', ctx.agentId, true, 'Main')
          await sessionStore.save(mainSession)
        }
      }

      const onTurnStart = makeOnTurnStart({ sessionStore, eventFactory, hooks: ctx.hooks, contractBus })
      const onTurnEnd = makeOnTurnEnd({ sessionStore, eventFactory, hooks: ctx.hooks })

      return {
        provide: {
          store: () => sessionStore,
          history: () => historyStore,
          compactor: () => createCompactor({ invoke: ctx.extensions.get<ProviderInvoke>('provider.llm') }),
          abort: () => ({
            register: (sessionId: string, controller: AbortController) => abortControllers.set(sessionId, controller),
            unregister: (sessionId: string) => { abortControllers.delete(sessionId) },
            abort: (sessionId: string) => { abortControllers.get(sessionId)?.abort() },
          }),
        },
        hooks: { kernelReady, onTurnStart, onTurnEnd },
        dispose: () => { db.close() },
      }
    },
  })
