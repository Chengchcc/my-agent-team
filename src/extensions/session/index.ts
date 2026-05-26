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
    void d.contractBus.emit(createEvent('turn.started', { sessionId, turnId: turn.id }, { sessionId, turnId: turn.id }));
    return turn;
  };
}

interface TurnEndDeps {
  sessionStore: SessionStore;
  eventFactory: ReturnType<typeof createTraceEventFactory>;
  hooks: HookContainer;
  contractBus: ReturnType<typeof asContractBus>;
}

function makeOnTurnEnd(d: TurnEndDeps): HookHandler {
  return async (...args: unknown[]) => {
    const result = args[0] as {
      sessionId: string;
      turnId: string;
      status: 'completed' | 'failed';
      usage?: { input: number; output: number };
      toolCallCount?: number;
      toolErrorCount?: number;
      finalMessage?: string;
      error?: { stage: string; reason: string };
      activatedSkills?: string[];
    };
    const { sessionId, turnId, status } = result;
    const session = await d.sessionStore.load(sessionId);
    if (session) { session.completeTurn(); await d.sessionStore.save(session); }

    // Emit trace event
    const traceEvt: TraceEvent = status === 'completed'
      ? d.eventFactory.next(turnId, 'turn.completed', { tokens: result.usage })
      : d.eventFactory.next(turnId, 'turn.failed', { error: result.error });
    await d.hooks.dispatch('onTraceEmit', traceEvt);

    // Emit contract bus event — single source of truth for turn termination
    if (status === 'completed') {
      void d.contractBus.emit(createEvent('turn.completed', {
        sessionId,
        turnId,
        usage: { input: result.usage?.input ?? null, output: result.usage?.output ?? null },
        toolCallCount: result.toolCallCount ?? 0,
        toolErrorCount: result.toolErrorCount ?? 0,
        activatedSkills: result.activatedSkills ?? [],
      }, { sessionId, turnId }));
    } else {
      void d.contractBus.emit(createEvent('turn.failed', {
        sessionId,
        turnId,
        outcome: 'error',
        stage: result.error?.stage ?? 'unknown',
        reason: result.error?.reason ?? 'Unknown error',
        toolErrorCount: result.toolErrorCount ?? 0,
      }, { sessionId, turnId }));
    }
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
      const onTurnEnd = makeOnTurnEnd({ sessionStore, eventFactory, hooks: ctx.hooks, contractBus })

      return {
        provide: {
          'session.store': () => sessionStore,
          'session.history': () => historyStore,
          'session.compactor': () => createCompactor({ invoke: ctx.extensions.get('provider.llm') }),
          'session.abort': () => ({
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
