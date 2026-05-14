// src/daemon/interactive-bridge.ts
import { globalPermissionManager } from '../tools/permission-manager';
import type { PermissionResponse } from '../tools/permission-manager';
import { globalAskUserQuestionManager } from '../tools/ask-user-question-manager';
import type { AskUserQuestionParameters, AskUserQuestionResult } from '../tools/ask-user-question';
import { buildPermissionCard, buildAskUserQuestionCard, buildResolvedCard } from '../im/lark/card-builder';
import { updateMessage } from '../im/lark/client';
import { debugLog, debugWarn } from '../utils/debug';

export interface InteractiveBridgeDeps {
  larkAppId: string;
  permissionTimeoutMs: number;
  sessionReply: (anchor: string, content: string, msgType?: string) => Promise<string>;
}

interface PendingPermission {
  resolve: (response: PermissionResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  msgId: string;
}

interface PendingAsk {
  resolve: (result: AskUserQuestionResult) => void;
  reject: (error: Error) => void;
  msgId: string;
}

export class InteractiveBridge {
  private deps: InteractiveBridgeDeps;
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingAsks = new Map<string, PendingAsk>();

  constructor(deps: InteractiveBridgeDeps) {
    this.deps = deps;
    debugLog('[InteractiveBridge] created');
  }

  async sendPermissionCard(
    anchor: string,
    toolName: string,
    reason: string,
    command: string,
    sessionId: string,
  ): Promise<PermissionResponse> {
    return new Promise((resolve) => {
      const card = buildPermissionCard({ sessionId, rootId: anchor, toolName, reason, command });
      const timeoutMs = this.deps.permissionTimeoutMs;

      this.deps.sessionReply(anchor, card, 'interactive').then((msgId) => {
        const timer = setTimeout(() => {
          debugLog(`[InteractiveBridge] permission timeout for session ${sessionId}`);
          this.resolvePermission(sessionId, 'deny');
          updateMessage(msgId, buildResolvedCard('已超时自动拒绝')).catch(() => {});
        }, timeoutMs);

        this.pendingPermissions.set(sessionId, { resolve, timer, msgId });
        debugLog(`[InteractiveBridge] permission card sent msgId=${msgId} session=${sessionId}`);
      }).catch((err) => {
        debugWarn(`[InteractiveBridge] failed to send permission card: ${err}`);
        resolve('deny');
      });
    });
  }

  async sendAskUserQuestionCard(
    anchor: string,
    params: AskUserQuestionParameters,
    sessionId: string,
  ): Promise<AskUserQuestionResult> {
    return new Promise((resolve, reject) => {
      const card = buildAskUserQuestionCard({
        sessionId,
        rootId: anchor,
        header: params.questions[0]?.header ?? 'Question',
        questions: params.questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
          multiSelect: q.multi_select,
        })),
      });

      this.deps.sessionReply(anchor, card, 'interactive').then((msgId) => {
        this.pendingAsks.set(sessionId, { resolve, reject, msgId });
        debugLog(`[InteractiveBridge] ask card sent msgId=${msgId} session=${sessionId}`);
      }).catch((err) => {
        debugWarn(`[InteractiveBridge] failed to send ask card: ${err}`);
        reject(new Error('Failed to send ask card'));
      });
    });
  }

  resolvePermission(sessionId: string, response: PermissionResponse): void {
    const entry = this.pendingPermissions.get(sessionId);
    if (!entry) {
      debugWarn(`[InteractiveBridge] no pending permission for session ${sessionId}`);
      return;
    }
    clearTimeout(entry.timer);
    this.pendingPermissions.delete(sessionId);
    entry.resolve(response);
    debugLog(`[InteractiveBridge] permission resolved: ${response} for session ${sessionId}`);

    // Also route through global manager so the tool's Promise resolves.
    globalPermissionManager.respond(response);
  }

  resolveAskUserQuestion(sessionId: string, result: AskUserQuestionResult): void {
    const entry = this.pendingAsks.get(sessionId);
    if (!entry) {
      debugWarn(`[InteractiveBridge] no pending ask for session ${sessionId}`);
      return;
    }
    this.pendingAsks.delete(sessionId);
    entry.resolve(result);
    debugLog(`[InteractiveBridge] ask resolved for session ${sessionId}`);

    // Also route through global manager so the tool's Promise resolves.
    globalAskUserQuestionManager.respondWithAnswers(result);
  }

  /** Cancel any pending permission for the given session (e.g. on session close). */
  cancelPermission(sessionId: string): void {
    const entry = this.pendingPermissions.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingPermissions.delete(sessionId);
    entry.resolve('deny');
    debugLog(`[InteractiveBridge] permission cancelled for session ${sessionId}`);
  }

  /** Cancel any pending ask for the given session (e.g. on session close). */
  cancelAsk(sessionId: string): void {
    const entry = this.pendingAsks.get(sessionId);
    if (!entry) return;
    this.pendingAsks.delete(sessionId);
    entry.reject(new Error('Session closed'));
    debugLog(`[InteractiveBridge] ask cancelled for session ${sessionId}`);
  }
}
