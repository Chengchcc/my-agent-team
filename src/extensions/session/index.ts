import { defineExtension } from '../../kernel/define-extension'
import type { HookHandler } from '../../kernel/define-extension'
import { createEvent, parseHistoryLine } from '../../application/contracts';
import { asContractBus } from '../../application/event-bus/contract-bus';
import type { HistoryRecordV1 } from '../../application/contracts';
import { InMemorySessionStore } from '../../infrastructure/session/inmem-session-store'
import { createSession } from '../../domain/session'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, writeFile, unlink } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTurn } from '../../domain/turn'
import { createTraceEventFactory } from '../../domain/trace-event'
import type { TraceEvent } from '../../domain/trace-event'
import { createCompactor } from './compactor'
import type { ProviderInvoke } from '../../application/ports/provider'
import type { HookContainer } from '../../kernel/hook-container'
import type { Logger } from '../../application/ports/logger'

// ── Module-level helpers ────────────────────────────────────────────────────

interface RestoreDeps {
  sessionDir: string;
  agentId: string;
  messageHistory: Map<string, HistoryRecordV1[]>;
  sessionStore: InMemorySessionStore;
  logger: Logger;
}

const META_PREFIX = '#SESSION_META '

function parseSessionMeta(line: string): { mode?: string } | null {
  if (!line.startsWith(META_PREFIX)) return null
  try { return JSON.parse(line.slice(META_PREFIX.length)) as { mode?: string } }
  catch { return null }
}

export function writeSessionMeta(sessionDir: string, sid: string, meta: { mode: string }): void {
  try {
    const ndjsonPath = join(sessionDir, `${sid}.ndjson`)
    const raw = existsSync(ndjsonPath) ? readFileSync(ndjsonPath, 'utf-8') : ''
    const lines = raw.split('\n')
    const metaLine = `${META_PREFIX}${JSON.stringify(meta)}`
    // Replace existing meta line or prepend
    const metaIdx = lines.findIndex(l => l.startsWith(META_PREFIX))
    if (metaIdx >= 0) lines[metaIdx] = metaLine
    else lines.unshift(metaLine)
    writeFileSync(ndjsonPath, lines.filter(l => l.length > 0).join('\n') + '\n', 'utf-8')
  } catch { /* best-effort meta persistence */ }
}

async function restoreFromDisk(d: RestoreDeps): Promise<void> {
  const dir = d.sessionDir;
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter(f => f.endsWith('.ndjson'));
  const saves: Promise<void>[] = [];
  for (const file of files) {
    try {
      const sid = file.replace('.ndjson', '');
      const raw = readFileSync(join(dir, file), 'utf-8');
      const allLines = raw.trim().split('\n').filter(l => l.length > 0)
      const metaLine = allLines.find(l => l.startsWith(META_PREFIX))
      const meta = metaLine ? parseSessionMeta(metaLine) : null
      const messages: HistoryRecordV1[] = allLines
        .filter(l => !l.startsWith(META_PREFIX))
        .map(line => parseHistoryLine(line))
        .filter((r): r is HistoryRecordV1 => r !== null);
      d.messageHistory.set(sid, messages);
      const s = createSession(sid, d.agentId, sid === 'main', `Session ${sid}`);
      if (meta?.mode) s.mode = meta.mode
      saves.push(d.sessionStore.save(s));
    } catch { /* skip corrupted files */ }
  }
  await Promise.all(saves);
  if (files.length > 0) d.logger.info('session', `Restored ${files.length} sessions from disk`);
}

async function appendNdjson(sessionDir: string, sid: string, msgs: HistoryRecordV1[]): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  const ndjsonPath = join(sessionDir, `${sid}.ndjson`);
  const lines = msgs.map(m => JSON.stringify(m)).join('\n') + '\n';
  await appendFile(ndjsonPath, lines, 'utf-8');
}

interface TurnStartDeps {
  sessionStore: InMemorySessionStore;
  eventFactory: ReturnType<typeof createTraceEventFactory>;
  hooks: HookContainer;
  contractBus: ReturnType<typeof asContractBus>;
}

function makeOnTurnStart(d: TurnStartDeps): HookHandler {
  return async (...args: unknown[]) => {
    const sessionId = args[0] as string;
    const frontendId = args[1] as string;

    const session = await d.sessionStore.load(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    session.startTurn(frontendId);
    await d.sessionStore.save(session);

    const turn = createTurn(
      `turn-${d.eventFactory.lastCursor + 1}`,
      sessionId,
    );
    const traceEvt = d.eventFactory.next(turn.id, 'turn.started', {
      sessionId,
      frontendId,
    });
    await d.hooks.dispatch('onTraceEmit', traceEvt);
    d.contractBus.emit(createEvent('turn.started', {
      sessionId,
      turnId: turn.id,
    }, { sessionId, turnId: turn.id }));

    return turn;
  };
}

interface TurnEndDeps {
  sessionStore: InMemorySessionStore;
  eventFactory: ReturnType<typeof createTraceEventFactory>;
  hooks: HookContainer;
}

function makeOnTurnEnd(d: TurnEndDeps): HookHandler {
  return async (...args: unknown[]) => {
    const result = args[0] as {
      sessionId: string
      turnId: string
      usage?: { input: number; output: number }
    };

    const session = await d.sessionStore.load(result.sessionId);
    if (session) {
      session.completeTurn();
      await d.sessionStore.save(session);
    }
    const traceEvt: TraceEvent = d.eventFactory.next(
      result.turnId,
      'turn.completed',
      { tokens: result.usage },
    );
    await d.hooks.dispatch('onTraceEmit', traceEvt);
  };
}

/**
 * Session extension — manages agent sessions, turns, and input queues.
 *
 * Capabilities exposed:
 *   - session.store: SessionStore (save, load, list, delete)
 *   - session.messages: @deprecated use session.history instead
 *   - session.history: { get, appendBatch } — message registry + NDJSON persistence
 *
 * Depends on:
 *   - trace: for recording trace events via onTraceEmit hook
 *
 * Hooks:
 *   - kernelReady: saves main session to store
 *   - onTurnStart (pre, sequential): validates state, creates Turn, emits trace
 *   - onTurnEnd (post, parallel): completes turn, saves session, emits trace + bus event
 */
export default () =>
  defineExtension({
    name: 'session',
    enforce: 'normal',
    dependsOn: ['trace'],

    apply: (ctx) => {
      const contractBus = asContractBus(ctx.bus)
      const sessionStore = new InMemorySessionStore()
      const eventFactory = createTraceEventFactory()

      // Per-session abort controllers for turn cancellation
      const abortControllers = new Map<string, AbortController>()

      // Per-session message history for attach replay + history persistence
      const messageHistory = new Map<string, HistoryRecordV1[]>()

      const sessionDir = ctx.paths.sessions

      // ── Hook handlers ─────────────────────────────────────────────────

      const kernelReady: HookHandler = async () => {
        await restoreFromDisk({ sessionDir, agentId: ctx.agentId, messageHistory, sessionStore, logger: ctx.logger })
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

          /** @deprecated use session.history.get instead */
          messages: () => ({
            get: (sid: string) => {
              if (!messageHistory.has(sid)) messageHistory.set(sid, [])
              return messageHistory.get(sid)!
            },
          }),

          history: () => ({
            get: (sid: string) => {
              if (!messageHistory.has(sid)) messageHistory.set(sid, [])
              return messageHistory.get(sid)!
            },
            appendBatch: async (sid: string, msgs: HistoryRecordV1[]) => {
              const arr = messageHistory.get(sid)
              if (!arr) {
                messageHistory.set(sid, [])
              }
              const target = messageHistory.get(sid)!
              target.push(...msgs)
              try {
                await appendNdjson(sessionDir, sid, msgs)
              } catch (err) {
                ctx.logger.warn('session', `NDJSON persist failed for ${sid}: ${String(err)}`)
              }
            },
            replace: async (sid: string, msgs: HistoryRecordV1[]) => {
              messageHistory.set(sid, [...msgs])
              try {
                const dir = sessionDir
                await mkdir(dir, { recursive: true })
                const ndjsonPath = join(dir, `${sid}.ndjson`)
                const lines = msgs.length > 0
                  ? msgs.map(m => JSON.stringify(m)).join('\n') + '\n'
                  : ''
                await writeFile(ndjsonPath, lines, 'utf-8')
              } catch (err) {
                ctx.logger.warn('session', `NDJSON rewrite failed for ${sid}: ${String(err)}`)
              }
            },
            drop: async (sid: string): Promise<boolean> => {
              let removed = false
              if (messageHistory.has(sid)) { messageHistory.delete(sid); removed = true }
              try { await unlink(join(sessionDir, `${sid}.ndjson`)); removed = true }
              catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.warn('session', `NDJSON unlink failed for ${sid}: ${String(err)}`) }
              return removed
            },
            clear: async (sid: string): Promise<void> => {
              messageHistory.set(sid, [])
              try {
                await mkdir(sessionDir, { recursive: true })
                await writeFile(join(sessionDir, `${sid}.ndjson`), '', 'utf-8')
              } catch (err) {
                ctx.logger.warn('session', `NDJSON clear failed for ${sid}: ${String(err)}`)
              }
            },
          }),

          compactor: () => createCompactor({
            invoke: ctx.extensions.get<ProviderInvoke>('provider.llm'),
          }),

          abort: () => ({
            register: (sessionId: string, controller: AbortController) => {
              abortControllers.set(sessionId, controller)
            },
            unregister: (sessionId: string) => {
              abortControllers.delete(sessionId)
            },
            abort: (sessionId: string) => {
              abortControllers.get(sessionId)?.abort()
            },
          }),
        },

        hooks: {
          kernelReady,
          onTurnStart,
          onTurnEnd,
        },

        dispose: async () => {
          sessionStore.clear()
        },
      }
    },
  })
