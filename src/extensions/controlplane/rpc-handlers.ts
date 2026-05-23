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
import { createEvent } from '../../application/contracts';
import { compactSessionUsecase, type Compactor } from '../../application/usecases/compact-session';
import type { SessionHistoryPort } from '../../application/ports/session-history';
import type { asContractBus } from '../../application/event-bus/contract-bus';

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
  contractBus: ReturnType<typeof asContractBus>;
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
    const sessionId = p?.sessionId ?? 'main';

    const store = d.getStore();
    const session = await store.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.attachFrontend(frontendId);
    await store.save(session);
    d.getServer().attachFrontend(frontendId, sessionId);
    d.contractBus.emit(createEvent('attach.changed', { frontendId, sessionId, action: 'attached' }));

    let messages: Array<{ role: string; content: string; blocks?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>; id?: string }> = [];
    try {
      const msgStore = d.ctx.extensions.get<{ get(sid: string): Array<{ role: string; content: string }> }>('session.messages');
      messages = msgStore.get(sessionId);
    } catch (e) { d.ctx.logger.warn('session', `failed to get messages: ${String(e)}`); }

    let snapshot: Array<{ role: string; content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> }> = [];
    try {
      const hist = d.ctx.extensions.get<{ get(sessionId: string): unknown[] }>('session.history');
      snapshot = hist.get(sessionId) as typeof snapshot;
    } catch { /* history may not be available */ }

    return { ok: true, sessionId, frontendId, messages, snapshot };
  };
}

export function makeSessionDetachHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { frontendId?: string; sessionId?: string } | undefined;
    const frontendId = p?.frontendId ?? 'unknown';
    const sessionId = p?.sessionId ?? 'main';

    const store = d.getStore();
    const session = await store.load(sessionId);
    if (session) { session.detachFrontend(frontendId); await store.save(session); }

    d.getServer().detachFrontend(frontendId, sessionId);
    d.contractBus.emit(createEvent('attach.changed', { frontendId, sessionId, action: 'detached' }));
    return { ok: true, sessionId, frontendId };
  };
}

export function makeSessionResumeHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string; frontendId?: string; currentSessionId?: string } | undefined;
    const targetId = p?.sessionId ?? 'main';
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
        d.contractBus.emit(createEvent('attach.changed', { frontendId, sessionId: currentId, action: 'detached' }));
      }
    }

    if (frontendId) {
      targetSession.attachFrontend(frontendId);
      await store.save(targetSession);
      d.getServer().attachFrontend(frontendId, targetId);
      d.contractBus.emit(createEvent('attach.changed', { frontendId, sessionId: targetId, action: 'attached' }));
    }

    d.contractBus.emit(createEvent('session.resumed', { sessionId: targetId, frontendId, previousSessionId: currentId ?? null }));

    let snapshot: Array<{ role: string; content: string }> = [];
    try {
      const hist = d.ctx.extensions.get<{ get(sessionId: string): unknown[] }>('session.history');
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
    d.contractBus.emit(createEvent('session.created', {
      id: session.id,
      title: session.title ?? session.id,
      agentId: session.agentId,
      isMain: session.isMain,
    }));
    return { ok: true, sessionId: id, session: d.sessionToJson(session) };
  };
}

export function makeSessionCloseHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string; force?: boolean } | undefined;
    const sessionId = p?.sessionId ?? 'main';
    const store = d.getStore();
    const session = await store.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.close(p?.force ?? false);
    await store.save(session);
    d.contractBus.emit(createEvent('session.closed', { sessionId, force: p?.force ?? false }));
    return { ok: true, sessionId, state: session.state };
  };
}

export function makeSessionRenameHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string; title?: string } | undefined;
    const sessionId = p?.sessionId ?? 'main';
    if (!p?.title) throw new Error('title is required');
    const store = d.getStore();
    const session = await store.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.title = p.title;
    await store.save(session);
    d.contractBus.emit(createEvent('session.renamed', { sessionId, title: p.title }));
    return { ok: true, sessionId, title: session.title };
  };
}

export function makeSessionClearHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string } | undefined;
    const sessionId = p?.sessionId ?? 'main';
    const store = d.getStore();
    const session = await store.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    // Clear message history via session.history capability
    try {
      const hist = d.ctx.extensions.get<{ clear(sessionId: string): void }>('session.history');
      if (typeof (hist as Record<string, unknown>).clear === 'function') {
        (hist as { clear(sessionId: string): void }).clear(sessionId);
      }
    } catch { /* history clear not available */ }
    d.contractBus.emit(createEvent('session.closed', { sessionId, force: true }));
    return { ok: true, sessionId };
  };
}

export function makeSessionCompactHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string; keepRecent?: number } | undefined;
    const sessionId = p?.sessionId ?? 'main';
    const compactor = d.ctx.extensions.get<Compactor>('session.compactor');
    const history = d.ctx.extensions.get<SessionHistoryPort>('session.history');
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
    const sessionId = p?.sessionId ?? 'main';
    let totalInput = 0, totalOutput = 0, turnCount = 0;
    try {
      const hist = d.ctx.extensions.get<{
        get(sessionId: string): Array<{ role: string; usage?: { input: number; output: number } }>
      }>('session.history');
      const msgs = hist.get(sessionId);
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
      const catalog = d.ctx.extensions.get<{
        list(): Array<{ name: string; description: string; parameters: Record<string, unknown> }>
      }>('tool-catalog.catalog');
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
    const sessionId = p?.sessionId ?? 'main';
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

    session.enqueueInput(p.text);
    const turn = await d.ctx.hooks.dispatch('onTurnStart', sessionId, frontendId) as { id?: string } | undefined;
    const turnId = turn?.id ?? `turn-${Date.now()}`;

    runTurnUsecase(
      { sessionId, turnId, userInput: p.text, frontendId },
      buildRunTurnDeps(d.ctx),
    ).catch((err) => { d.ctx.logger.warn('turn', `Turn ${turnId} failed: ${String(err)}`); });

    await store.save(session);
    return { accepted: true, sessionId, turnId, queued: false };
  };
}

export function makeInputCancelHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string; reason?: string } | undefined;
    const sessionId = p?.sessionId ?? 'main';
    const reason = p?.reason ?? 'user requested';

    try {
      const sessionAbort = d.ctx.extensions.get<{ abort(sessionId: string): void }>('session.abort');
      sessionAbort.abort(sessionId);
    } catch { /* session.abort may not be registered yet */ }

    const store = d.getStore();
    const session = await store.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    d.contractBus.emit(createEvent('input.cancelled', { sessionId, reason }));
    if (session.state === 'RUNNING') {
      session.pendingInputs.length = 0;
      try { session.completeTurn(); } catch { /* may already be IDLE */ }
      await store.save(session);
      d.contractBus.emit(createEvent('turn.cancelled', { sessionId, reason }));
    }
    return { cancelled: true, sessionId, reason };
  };
}

// ── User interaction ────────────────────────────────────────────────────────

export function makeUserAnswerHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string; questionId?: string; answers?: Array<{ question_index: number; selected_labels: string[] }> } | undefined;
    if (!p?.questionId) throw new Error('questionId is required');
    d.contractBus.emit(createEvent('user.question.answered', { sessionId: p?.sessionId ?? 'main', questionId: p.questionId, answers: p?.answers ?? [] }));
    return { ok: true, sessionId: p?.sessionId ?? 'main', questionId: p.questionId };
  };
}

// ── System domain ───────────────────────────────────────────────────────────

export function makeSystemHealthHandler(d: RpcHandlerDeps) {
  return async () => {
    let sessionOk = false;
    try { sessionOk = (await d.getStore().load('main')) !== null; } catch { /* unavailable */ }
    return {
      status: 'ok', uptimeMs: d.ctx.clock.now(), agentId: d.ctx.agentId,
      extensions: d.ctx.extensions.list().length, rpcMethods: d.ctx.rpc.listMethods().length,
      subsystems: { session: sessionOk ? 'ok' : 'unavailable' },
    };
  };
}

export function makeSystemShutdownHandler(d: RpcHandlerDeps) {
  return async () => {
    await d.contractBus.emit(createEvent('system.shutdown.requested', { agentId: d.ctx.agentId, timestamp: new Date().toISOString() }));
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
