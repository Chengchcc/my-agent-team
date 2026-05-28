/**
 * RPC handler builders for the controlplane extension.
 *
 * Each builder is a module-level function that receives shared dependencies
 * and returns an async RPC handler. This keeps the main apply() thin.
 */

import type { KernelContext } from '../../kernel/kernel-context';
import type { SessionStore } from '../../application/ports/session-store';
import type { Session } from '../../domain/session';
import { createSession } from '../../domain/session';
import { runTurnUsecase, buildRunTurnDeps } from '../../application/usecases/run-turn';
import { compactSessionUsecase } from '../../application/usecases/compact-session';
import type { ContractBus } from '../../application/event-bus/contract-bus';
import { MAIN_SESSION_ID } from '../../domain/anchor';

const SESSION_ID_SUFFIX_LEN = 8;

// ── Internal types ──────────────────────────────────────────────────────────

interface ControlPlaneServer {
  attachFrontend(frontendId: string, sessionId: string): void;
  detachFrontend(frontendId: string, sessionId: string): void;
}

/** Shared dependencies all RPC handlers need. */
export interface RpcHandlerDeps {
  ctx: KernelContext;
  getStore: () => SessionStore;
  getServer: () => ControlPlaneServer;
  contractBus: ContractBus;
  sessionToJson: (s: Session) => Record<string, unknown>;
  nextSessionId: () => string;
}

// ── Session domain ──────────────────────────────────────────────────────────

export function makeSessionListHandler(d: RpcHandlerDeps) {
  return async () => {
    const store = d.getStore();
    const sessions = await store.list(d.ctx.agentId);
    return { sessions: sessions.map(d.sessionToJson) };
  };
}

export function makeSessionAttachHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { frontendId?: string; sessionId?: string } | undefined;
    if (!p?.frontendId) throw new Error('frontendId is required');
    const frontendId = p.frontendId;
    if (!p?.sessionId) throw new Error('sessionId is required');
    const sessionId = p.sessionId;

    const store = d.getStore();
    const session = await store.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.attachFrontend(frontendId);
    await store.save(session);
    d.getServer().attachFrontend(frontendId, sessionId);
    void d.contractBus.emit('attach.changed', { frontendId, sessionId, action: 'attached' });

    let messages: Array<{ role: string; content: string; blocks?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>; id?: string }> = [];
    try {
      const msgStore = d.ctx.extensions.get('session.messages');
      messages = msgStore.get(sessionId);
    } catch (e) { d.ctx.logger.warn('session', `failed to get messages: ${String(e)}`); }

    let snapshot: Array<{ role: string; content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> }> = [];
    try {
      const hist = d.ctx.extensions.get('session.history');
      snapshot = hist.get(sessionId) as typeof snapshot;
    } catch { /* history may not be available */ }

    return { ok: true, sessionId, frontendId, messages, snapshot };
  };
}

export function makeSessionDetachHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { frontendId?: string; sessionId?: string } | undefined;
    if (!p?.frontendId) throw new Error('frontendId is required');
    const frontendId = p.frontendId;
    if (!p?.sessionId) throw new Error('sessionId is required');
    const sessionId = p.sessionId;

    const store = d.getStore();
    const session = await store.load(sessionId);
    if (session) { session.detachFrontend(frontendId); await store.save(session); }

    d.getServer().detachFrontend(frontendId, sessionId);
    void d.contractBus.emit('attach.changed', { frontendId, sessionId, action: 'detached' });
    return { ok: true, sessionId, frontendId };
  };
}

export function makeSessionResumeHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string; frontendId?: string; currentSessionId?: string } | undefined;
    const targetId = p?.sessionId ?? MAIN_SESSION_ID;
    const frontendId = p?.frontendId;
    const currentId = p?.currentSessionId;

    const store = d.getStore();
    const targetSession = await store.load(targetId);
    if (!targetSession) throw new Error(`Session not found: ${targetId}`);

    if (currentId) {
      const currentSession = await store.load(currentId);
      if (currentSession && frontendId) {
        currentSession.detachFrontend(frontendId);
        await store.save(currentSession);
        d.getServer().detachFrontend(frontendId, currentId);
        void d.contractBus.emit('attach.changed', { frontendId, sessionId: currentId, action: 'detached' });
      }
    }

    if (frontendId) {
      targetSession.attachFrontend(frontendId);
      await store.save(targetSession);
      d.getServer().attachFrontend(frontendId, targetId);
      void d.contractBus.emit('attach.changed', { frontendId, sessionId: targetId, action: 'attached' });
    }

    void d.contractBus.emit('session.resumed', { sessionId: targetId, frontendId, previousSessionId: currentId ?? null });

    let snapshot: Array<{ role: string; content: string }> = [];
    try {
      const hist = d.ctx.extensions.get('session.history');
      snapshot = hist.get(targetId) as typeof snapshot;
    } catch { /* history may not be available */ }

    return { ok: true, sessionId: targetId, session: d.sessionToJson(targetSession), snapshot };
  };
}

export function makeSessionCreateHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { title?: string; anchor?: { scope?: string; key?: string }; frontendId?: string } | undefined;
    const id = d.nextSessionId();
    const session = createSession(id, d.ctx.agentId, false, p?.title ?? `Session ${id.slice(-SESSION_ID_SUFFIX_LEN)}`);
    const store = d.getStore();
    await store.save(session);
    if (p?.frontendId) { session.attachFrontend(p.frontendId); await store.save(session); }
    void d.contractBus.emit('session.created', {
      id: session.id,
      title: session.title ?? session.id,
      agentId: session.agentId,
      isMain: session.isMain,
    });
    return { ok: true, sessionId: id, session: d.sessionToJson(session) };
  };
}

export function makeSessionCloseHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string; force?: boolean } | undefined;
    const sessionId = p?.sessionId ?? MAIN_SESSION_ID;
    const store = d.getStore();
    const session = await store.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.close(p?.force ?? false);
    await store.save(session);
    void d.contractBus.emit('session.closed', { sessionId, force: p?.force ?? false });
    return { ok: true, sessionId, state: session.state };
  };
}

export function makeSessionRenameHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string; title?: string } | undefined;
    const sessionId = p?.sessionId ?? MAIN_SESSION_ID;
    if (!p?.title) throw new Error('title is required');
    const store = d.getStore();
    const session = await store.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.title = p.title;
    await store.save(session);
    void d.contractBus.emit('session.renamed', { sessionId, title: p.title });
    return { ok: true, sessionId, title: session.title };
  };
}

export function makeSessionClearHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string } | undefined;
    const sessionId = p?.sessionId ?? MAIN_SESSION_ID;
    const store = d.getStore();
    const session = await store.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // 1. Cancel in-flight turn to prevent residual events
    if (d.ctx.extensions.has('session.abort')) {
      const abort = d.ctx.extensions.get('session.abort')
      abort?.abort(sessionId)
    } else {
      d.ctx.logger.warn('session', 'session.abort not available, cannot abort turn')
    }

    // 2. Clear message history
    const hist = d.ctx.extensions.get('session.history')
    if (hist) await hist.clear(sessionId)

    // 3. Emit correct event
    void d.contractBus.emit('session.cleared', { sessionId, ts: Date.now() }, { sessionId })
    return { ok: true, sessionId }
  };
}

export function makeSessionCompactHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string; keepRecent?: number } | undefined;
    const sessionId = p?.sessionId ?? MAIN_SESSION_ID;
    const compactor = d.ctx.extensions.get('session.compactor');
    const history = d.ctx.extensions.get('session.history');
    const r = await compactSessionUsecase(
      { sessionId, keepRecent: p?.keepRecent },
      { history, compactor, bus: d.ctx.bus },
    );
    return r;
  };
}

export function makeSessionStatsHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string } | undefined;
    const sessionId = p?.sessionId ?? MAIN_SESSION_ID;
    let totalInput = 0, totalOutput = 0, turnCount = 0;
    try {
      const hist = d.ctx.extensions.get('session.history');
      const msgs = hist.get(sessionId) as unknown as Array<{ role: string; usage?: { input: number; output: number } }>;
      for (const m of msgs) {
        if (m.usage) {
          totalInput += m.usage.input;
          totalOutput += m.usage.output;
          turnCount++;
        }
      }
    } catch { /* history not available */ }
    return { ok: true, sessionId, usage: { input: totalInput, output: totalOutput }, turnCount };
  };
}

// ── Tool domain ─────────────────────────────────────────────────────────────

export function makeToolListHandler(d: RpcHandlerDeps) {
  return async () => {
    try {
      const catalog = d.ctx.extensions.get('tool-catalog.catalog');
      const tools = catalog.list().map(t => ({
        name: t.name, description: t.description, parameters: t.parameters,
      }));
      return { tools };
    } catch {
      return { tools: [] };
    }
  };
}

// ── Input domain ────────────────────────────────────────────────────────────

export function makeInputSendHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string; text?: string; frontendId?: string } | undefined;
    const sessionId = p?.sessionId ?? MAIN_SESSION_ID;
    if (p?.text === undefined) throw new Error('text is required');
    const frontendId = p?.frontendId ?? 'unknown';

    const store = d.getStore();
    const session = await store.load(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.state === 'RUNNING') {
      session.enqueueInput(p.text);
      await store.save(session);
      return { accepted: true, sessionId, queued: true, queueDepth: session.pendingInputs.length };
    }

    const turn = await d.ctx.hooks.dispatch('onTurnStart', sessionId, frontendId) as { id?: string } | undefined;
    const turnId = turn?.id ?? `turn-${Date.now()}`;

    runTurnUsecase(
      { sessionId, turnId, userInput: p.text, frontendId },
      buildRunTurnDeps(d.ctx),
    ).catch((err) => { d.ctx.logger.warn('turn', `Turn ${turnId} failed: ${String(err)}`); });

    return { accepted: true, sessionId, turnId, queued: false };
  };
}

export function makeInputCancelHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string; reason?: string } | undefined;
    const sessionId = p?.sessionId ?? MAIN_SESSION_ID;
    const reason = p?.reason ?? 'user requested';

    if (d.ctx.extensions.has('session.abort')) {
      const sessionAbort = d.ctx.extensions.get('session.abort');
      sessionAbort.abort(sessionId);
    } else {
      d.ctx.logger.warn('session', 'session.abort not available, cannot abort turn');
    }

    const store = d.getStore();
    const session = await store.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    void d.contractBus.emit('input.cancelled', { sessionId, reason });
    if (session.state === 'RUNNING') {
      session.pendingInputs.length = 0;
    }
    return { cancelled: true, sessionId, reason };
  };
}

// ── User interaction ────────────────────────────────────────────────────────

export function makeUserAnswerHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string; questionId?: string; answers?: Array<{ question_index: number; selected_labels: string[] }> } | undefined;
    if (!p?.questionId) throw new Error('questionId is required');
    void d.contractBus.emit('user.question.answered', { sessionId: p?.sessionId ?? MAIN_SESSION_ID, questionId: p.questionId, answers: p?.answers ?? [] });
    return { ok: true, sessionId: p?.sessionId ?? MAIN_SESSION_ID, questionId: p.questionId };
  };
}

// ── System domain ───────────────────────────────────────────────────────────

export function makeSystemHealthHandler(d: RpcHandlerDeps) {
  return async () => {
    let sessionOk = false;
    try { sessionOk = (await d.getStore().load('tui-default')) !== null; } catch { /* unavailable */ }
    return {
      status: 'ok', uptimeMs: d.ctx.clock.now(), agentId: d.ctx.agentId,
      extensions: d.ctx.extensions.list().length, rpcMethods: d.ctx.rpc.listMethods().length,
      subsystems: { session: sessionOk ? 'ok' : 'unavailable' },
    };
  };
}

export function makeSystemShutdownHandler(d: RpcHandlerDeps) {
  return async () => {
    await d.contractBus.emit('system.shutdown.requested', { agentId: d.ctx.agentId, timestamp: new Date().toISOString() });
    d.ctx.logger.info('system', 'Shutdown requested via RPC');
    return { shuttingDown: true, message: 'Shutdown initiated. The kernel will stop after active turns complete.' };
  };
}

export function makeSystemVersionHandler(d: RpcHandlerDeps) {
  return () => ({
    daemonVersion: '2.0.0', kernelVersion: '1.0.0',
    agentId: d.ctx.agentId, protocolVersion: '2.0',
  });
}
