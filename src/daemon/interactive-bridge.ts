// src/daemon/interactive-bridge.ts
import { globalPermissionManager } from '../tools/permission-manager';
import type { PermissionResponse } from '../tools/permission-manager';
import { globalAskUserQuestionManager } from '../tools/ask-user-question-manager';
import type { AskUserQuestionParameters, AskUserQuestionResult } from '../tools/ask-user-question';
import { debugLog } from '../utils/debug';

interface InteractiveBridgeDeps {
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
    _anchor: string,
    toolName: string,
    reason: string,
    _command: string,
    _sessionId: string,
  ): Promise<PermissionResponse> {
    // Send a text warning and auto-deny. Interactive cards are not used for
    // permission prompts — users grant permission by replying in chat.
    const msg = `⚠️ 检测到危险操作: **${toolName}** — ${reason}\n已自动阻止。如需执行请发送 \`允许\`。`;
    this.deps.sessionReply(_anchor, msg).catch(() => {});
    return 'deny';
  }

  async sendAskUserQuestionCard(
    anchor: string,
    params: AskUserQuestionParameters,
    _sessionId: string,
  ): Promise<AskUserQuestionResult> {
    // Render questions as a text message with numbered options
    const lines = params.questions.map((q) => {
      const opts = q.options.map((o, idx) => `  ${idx + 1}. ${o.label} — ${o.description}`).join('\n');
      return `**${q.header}**\n${q.question}\n${opts}`;
    });
    const msg = lines.join('\n\n');
    this.deps.sessionReply(anchor, msg).catch(() => {});
    // Return first option as default
    return {
      answers: params.questions.map((q, idx) => ({
        question_index: idx,
        selected_labels: [q.options[0]?.label ?? ''],
      })),
    };
  }

  resolvePermission(sessionId: string, response: PermissionResponse): void {
    const entry = this.pendingPermissions.get(sessionId);
    if (!entry) {
      debugLog(`[InteractiveBridge] no pending permission for session ${sessionId}`);
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
      debugLog(`[InteractiveBridge] no pending ask for session ${sessionId}`);
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
