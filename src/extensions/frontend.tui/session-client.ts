import type { Transport } from '../../application/ports/transport';
import type { DataPlaneEvent } from '../../application/contracts';
import { MAIN_SESSION_ID } from '../../domain/anchor';

export interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  lastActiveAt: string;
}

export interface AttachResult {
  sessionId: string;
  frontendId: string;
  snapshot: Array<Record<string, unknown>>;
}

export interface ResumeResult {
  sessionId: string;
  session: Record<string, unknown>;
  snapshot: Array<Record<string, unknown>>;
}

import { nanoid } from 'nanoid';
function nextId(): string {
  return `rpc-${nanoid()}`;
}

export class SessionClient {
  constructor(
    private transport: Transport,
    private frontendId: string,
  ) {}

  private async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const response = await this.transport.sendRpc({
      jsonrpc: '2.0',
      id: nextId(),
      method,
      params,
    });
    if (response?.error) {
      throw new Error(response.error.message);
    }
    return response?.result ?? null;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const result = (await this.call('session.list', {})) as { sessions: SessionSummary[] };
    return result.sessions;
  }

  async attachSession(sessionId?: string): Promise<AttachResult> {
    return this.call('session.attach', {
      frontendId: this.frontendId,
      sessionId: sessionId ?? MAIN_SESSION_ID,
    }) as Promise<AttachResult>;
  }

  async resumeSession(targetSessionId: string, currentSessionId?: string): Promise<ResumeResult> {
    return this.call('session.resume', {
      frontendId: this.frontendId,
      sessionId: targetSessionId,
      currentSessionId: currentSessionId ?? MAIN_SESSION_ID,
    }) as Promise<ResumeResult>;
  }

  async sendRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.call(method, params);
  }

  async createSession(title?: string): Promise<{ sessionId: string }> {
    return this.call('session.create', {
      frontendId: this.frontendId,
      title,
    }) as Promise<{ sessionId: string }>;
  }

  async sendInput(sessionId: string, text: string): Promise<unknown> {
    return this.call('input.send', {
      sessionId,
      frontendId: this.frontendId,
      text,
    });
  }

  async cancelInput(sessionId: string, reason?: string): Promise<void> {
    await this.call('input.cancel', {
      sessionId,
      reason,
    });
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.call('session.clear', { sessionId });
  }

  async compactSession(sessionId: string): Promise<void> {
    await this.call('session.compact', { sessionId });
  }

  async getSessionStats(sessionId: string): Promise<{ input: number; output: number; turnCount: number }> {
    const result = (await this.call('session.stats', { sessionId })) as {
      ok: boolean;
      usage: { input: number; output: number };
      turnCount: number;
    };
    return { input: result.usage.input, output: result.usage.output, turnCount: result.turnCount };
  }

  async getToolList(): Promise<Array<{ name: string; description: string; parameters: Record<string, unknown> }>> {
    const result = (await this.call('tool.list', {})) as {
      tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    };
    return result.tools;
  }

  subscribeEvents(sessionId: string, cb: (event: DataPlaneEvent) => void): () => void {
    return this.transport.onEvent((event: DataPlaneEvent) => {
      if (event.sessionId === sessionId || !event.sessionId) {
        cb(event);
      }
    });
  }
}
