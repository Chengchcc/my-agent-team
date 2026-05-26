// P-3: executeTurn extracted to domain/turn-runner.ts; input.send delegates to runTurnUsecase.
// buildRunTurnDeps (in application/usecases/run-turn.ts) is the single ctx->application glue boundary.

import { defineExtension } from '../../kernel/define-extension';
import type { SessionStore } from '../../application/ports/session-store';
import type { Session } from '../../domain/session';
import { asContractBus } from '../../application/event-bus/contract-bus';
import {
  makeSessionListHandler,
  makeSessionAttachHandler,
  makeSessionDetachHandler,
  makeSessionResumeHandler,
  makeSessionCreateHandler,
  makeSessionCloseHandler,
  makeSessionRenameHandler,
  makeSessionClearHandler,
  makeSessionCompactHandler,
  makeSessionStatsHandler,
  makeToolListHandler,
  makeInputSendHandler,
  makeInputCancelHandler,
  makeUserAnswerHandler,
  makeSystemHealthHandler,
  makeSystemShutdownHandler,
  makeSystemVersionHandler,
} from './rpc-handlers';
import type { RpcHandlerDeps } from './rpc-handlers';

// ── Extension ───────────────────────────────────────────────────────────────

export default () =>
  defineExtension({
    name: 'controlplane-methods',
    enforce: 'post',
    dependsOn: ['controlplane'],

    apply: (ctx) => {
      const getStore = (): SessionStore => {
        try { return ctx.extensions.get('session.store'); }
        catch { throw new Error('Session store is not available. The "session" extension must be registered.'); }
      };

      const getServer = () => ctx.extensions.get('controlplane.server');
      const contractBus = asContractBus(ctx.bus);

      function sessionToJson(s: Session) {
        return {
          id: s.id, agentId: s.agentId, state: s.state, isMain: s.isMain,
          title: s.title ?? null, pendingInputs: [...s.pendingInputs],
          attachedFrontendIds: [...s.attachedFrontendIds],
          createdAt: s.createdAt.toISOString(), lastActiveAt: s.lastActiveAt.toISOString(),
        };
      }

      function nextSessionId(): string {
        // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- toString radix
        return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }

      const deps: RpcHandlerDeps = { ctx, getStore, getServer, contractBus, sessionToJson, nextSessionId };

      const rpc = {
        'session.list': makeSessionListHandler(deps),
        'session.attach': makeSessionAttachHandler(deps),
        'session.detach': makeSessionDetachHandler(deps),
        'session.resume': makeSessionResumeHandler(deps),
        'session.create': makeSessionCreateHandler(deps),
        'session.close': makeSessionCloseHandler(deps),
        'session.rename': makeSessionRenameHandler(deps),
        'session.clear': makeSessionClearHandler(deps),
        'session.compact': makeSessionCompactHandler(deps),
        'session.stats': makeSessionStatsHandler(deps),
        'tool.list': makeToolListHandler(deps),
        'input.send': makeInputSendHandler(deps),
        'input.cancel': makeInputCancelHandler(deps),
        'user.answer': makeUserAnswerHandler(deps),
        'system.health': makeSystemHealthHandler(deps),
        'system.shutdown': makeSystemShutdownHandler(deps),
        'system.version': makeSystemVersionHandler(deps),
        'system.ping': () => ({ ok: true, ts: Date.now() }),
      };

      return { rpc };
    },
  });

// ── Internal types ──────────────────────────────────────────────────────────

// ControlPlaneServer local type kept for structural typing in getServer()
