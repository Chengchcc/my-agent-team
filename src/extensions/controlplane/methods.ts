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
      const cfg = (ctx.config as { allowSubAgentDirectInvoke?: boolean } | undefined)
      const allowSubAgentInvoke = cfg?.allowSubAgentDirectInvoke ?? false
      if (allowSubAgentInvoke) {
        ctx.logger.warn('security', 'allowSubAgentDirectInvoke=true. Direct RPC invocation enabled. Do not use in production.')
      }

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

        'subagent.list': async () => {
          let reg: { list(): Array<{ type: string; description: string; allowedToolNames: readonly string[]; source: string; maxRounds?: number; maxTokensPerCall?: number; maxTotalTokens?: number; lifetimeMs?: number; modelHint?: 'fast' | 'strong' }> } | null = null
          try { reg = ctx.extensions.get('sub-agent.registry') } catch { /* unavailable */ }
          if (!reg) return { agents: [] }
          return {
            agents: reg.list().map(d => ({
              type: d.type,
              description: d.description,
              allowedToolNames: [...d.allowedToolNames],
              source: d.source,
              maxRounds: d.maxRounds,
              maxTokensPerCall: d.maxTokensPerCall,
              maxTotalTokens: d.maxTotalTokens,
              lifetimeMs: d.lifetimeMs,
              modelHint: d.modelHint,
            })),
          }
        },

        'subagent.describe': async (args: unknown) => {
          const p = args as { type?: string }
          if (!p?.type) throw new Error('type is required')
          let reg: { get(type: string): { type: string; description: string; allowedToolNames: readonly string[]; source: string; maxRounds?: number; maxTokensPerCall?: number; maxTotalTokens?: number; lifetimeMs?: number; modelHint?: 'fast' | 'strong' } | undefined } | null = null
          try { reg = ctx.extensions.get('sub-agent.registry') } catch { /* unavailable */ }
          if (!reg) return { found: false }
          const d = reg.get(p.type)
          if (!d) return { found: false }
          return {
            found: true,
            agent: {
              type: d.type,
              description: d.description,
              allowedToolNames: [...d.allowedToolNames],
              source: d.source,
              maxRounds: d.maxRounds,
              maxTokensPerCall: d.maxTokensPerCall,
              maxTotalTokens: d.maxTotalTokens,
              lifetimeMs: d.lifetimeMs,
              modelHint: d.modelHint,
            },
          }
        },

        // C-3: direct invoke (debug only, gated by allowSubAgentDirectInvoke config)
        ...(allowSubAgentInvoke ? {
          'subagent.invoke': async (args: unknown) => {
            const p = args as { type?: string; prompt?: string; description?: string }
            if (!p?.type) throw new Error('type is required')
            if (!p?.prompt) throw new Error('prompt is required')

            let runner: ((input: { type: string; prompt: string; description: string; parentSessionId: string; parentTurnId: string; parentCallId: string; parentSignal: AbortSignal }) => Promise<string>) | null = null
            try { runner = ctx.extensions.get('sub-agent.runner') } catch { throw new Error('sub-agent extension not loaded') }

            const controller = new AbortController()
            const result = await runner({
              type: p.type,
              prompt: p.prompt,
              description: p.description ?? `direct invoke: ${p.type}`,
              parentSessionId: '__controlplane_debug__',
              parentTurnId: `cp-debug-${Date.now()}`,
              parentCallId: `cp-call-${Date.now()}`,
              parentSignal: controller.signal,
            })
            return { result }
          },
        } : {}),
      };

      return { rpc };
    },
  });

// ── Internal types ──────────────────────────────────────────────────────────

// ControlPlaneServer local type kept for structural typing in getServer()
