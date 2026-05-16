import { debugWarn } from '../utils/debug';

export const PERMISSION_RESPONSES = ['allow', 'deny', 'always'] as const;
export type PermissionResponse = (typeof PERMISSION_RESPONSES)[number];

export type PermissionRequest = {
  toolName: string;
  reason: string;
  resolve: (response: PermissionResponse) => void;
  reject: (error: Error) => void;
};

const MAX_QUEUE_SIZE = 10;
const TUI_SESSION = '__tui__';

/** Minimal bridge interface — avoids importing InteractiveBridge directly. */
export interface PermissionBridge {
  sendPermissionCard(
    anchor: string,
    toolName: string,
    reason: string,
    command: string,
    sessionId: string,
  ): Promise<PermissionResponse>;
}

export class PermissionManager {
  private queues = new Map<string, PermissionRequest[]>();
  private currentRequests = new Map<string, PermissionRequest>();
  private bridges = new Map<string, PermissionBridge>();
  private anchors = new Map<string, string>();
  private tuiCallback: ((req: PermissionRequest | null) => void) | null = null;

  constructor() {
    // Initialize a default queue for the TUI (single-session interactive mode)
    this.queues.set(TUI_SESSION, []);
  }

  registerSession(sessionId: string, bridge: PermissionBridge, anchor: string): void {
    this.bridges.set(sessionId, bridge);
    this.anchors.set(sessionId, anchor);
    if (!this.queues.has(sessionId)) {
      this.queues.set(sessionId, []);
    }
  }

  unregisterSession(sessionId: string): void {
    this.bridges.delete(sessionId);
    this.anchors.delete(sessionId);
    // Reject any pending requests for this session
    const current = this.currentRequests.get(sessionId);
    if (current) {
      current.reject(new Error('Session closed'));
      this.currentRequests.delete(sessionId);
    }
    const queue = this.queues.get(sessionId);
    if (queue) {
      for (const req of queue) {
        req.reject(new Error('Session closed'));
      }
    }
    this.queues.delete(sessionId);
  }

  getBridge(sessionId: string): PermissionBridge | undefined {
    return this.bridges.get(sessionId);
  }

  /** Resolve a session key from the raw value that may be the TUI default. */
  private resolveSessionId(raw: string): string {
    return raw === 'unknown' ? TUI_SESSION : raw;
  }

  requestPermission = (toolName: string, reason: string, sessionId: string): Promise<PermissionResponse> => {
    return new Promise((resolve, reject) => {
      const sid = this.resolveSessionId(sessionId);
      const queue = this.queues.get(sid);
      if (!queue) {
        reject(new Error(`Session ${sid} not registered for permission requests`));
        return;
      }
      if (queue.length >= MAX_QUEUE_SIZE) {
        debugWarn('[PermissionManager] Queue overflow; rejecting request.');
        reject(new Error('Permission request queue overflow'));
        return;
      }
      queue.push({ toolName, reason, resolve, reject });
      this._processQueue(sid);
    });
  };

  private _processQueue(sessionId: string) {
    if (this.currentRequests.has(sessionId)) return;
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) {
      // Notify TUI that queue is empty
      if (sessionId === TUI_SESSION) {
        this.tuiCallback?.(null);
      }
      return;
    }

    const req = queue.shift()!;
    this.currentRequests.set(sessionId, req);

    // TUI flow: notify the UI subscriber instead of calling a bridge
    if (sessionId === TUI_SESSION) {
      this.tuiCallback?.(req);
      return;
    }

    // Daemon flow: route through registered bridge
    const bridge = this.bridges.get(sessionId);
    const anchor = this.anchors.get(sessionId);
    if (!bridge || !anchor) {
      req.reject(new Error('No bridge or anchor for session'));
      this.currentRequests.delete(sessionId);
      this._processQueue(sessionId);
      return;
    }

    bridge.sendPermissionCard(anchor, req.toolName, req.reason, req.reason, sessionId)
      .catch(() => {
        this.respond('deny', sessionId);
      });
  }

  /** Legacy TUI subscribe — watches the built-in TUI session. */
  subscribe(callback: (req: PermissionRequest | null) => void): () => void {
    this.tuiCallback = callback;
    // Send current state to new subscriber
    const current = this.currentRequests.get(TUI_SESSION);
    if (current) {
      callback(current);
    } else if ((this.queues.get(TUI_SESSION)?.length ?? 0) === 0) {
      callback(null);
    }
    this._processQueue(TUI_SESSION);
    return () => {
      this.tuiCallback = null;
      // Reject all pending TUI requests
      for (const req of this.queues.get(TUI_SESSION) ?? []) {
        req.reject(new Error('PermissionManager: subscriber unsubscribed'));
      }
      this.queues.set(TUI_SESSION, []);
      const current = this.currentRequests.get(TUI_SESSION);
      if (current) {
        current.reject(new Error('PermissionManager: subscriber unsubscribed'));
        this.currentRequests.delete(TUI_SESSION);
      }
    };
  }

  respond = (response: PermissionResponse, sessionId?: string) => {
    const sid = sessionId ?? TUI_SESSION;
    const current = this.currentRequests.get(sid);
    if (!current) return;
    current.resolve(response);
    this.currentRequests.delete(sid);
    this._processQueue(sid);
  };
}

export const globalPermissionManager = new PermissionManager();
