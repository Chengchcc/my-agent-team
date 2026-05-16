import { describe, it, expect } from 'bun:test';
import { PermissionManager, type PermissionResponse, type PermissionBridge } from '../../src/tools/permission-manager';

function makeBridge(): PermissionBridge & { lastCall: { anchor: string; toolName: string; reason: string; command: string; sessionId: string } | null } {
  const bridge: PermissionBridge & { lastCall: { anchor: string; toolName: string; reason: string; command: string; sessionId: string } | null } = {
    lastCall: null,
    async sendPermissionCard(anchor: string, toolName: string, reason: string, command: string, sessionId: string): Promise<PermissionResponse> {
      bridge.lastCall = { anchor, toolName, reason, command, sessionId };
      // Return a promise that never resolves — we control resolution via respond()
      return new Promise(() => {});
    },
  };
  return bridge;
}

describe('PermissionManager', () => {
  // B01: registerSession sets up queue
  describe('registerSession (B01)', () => {
    it('sets up queue, bridge, and anchor for a new session', () => {
      const pm = new PermissionManager();
      const bridge = makeBridge();
      pm.registerSession('sess-1', bridge, 'oc_anchor1');

      // Verify bridge is stored
      expect(pm.getBridge('sess-1')).toBe(bridge);
    });

    it('creates a new queue for each session', () => {
      const pm = new PermissionManager();
      const b1 = makeBridge();
      const b2 = makeBridge();

      pm.registerSession('sess-1', b1, 'anchor1');
      pm.registerSession('sess-2', b2, 'anchor2');

      expect(pm.getBridge('sess-1')).toBe(b1);
      expect(pm.getBridge('sess-2')).toBe(b2);
      expect(pm.getBridge('unknown')).toBeUndefined();
    });
  });

  // B02: Two sessions can have concurrent permission requests
  describe('concurrent sessions (B02)', () => {
    it('two sessions can have independent concurrent permission requests', async () => {
      const pm = new PermissionManager();
      const b1 = makeBridge();
      const b2 = makeBridge();

      pm.registerSession('sess-1', b1, 'anchor1');
      pm.registerSession('sess-2', b2, 'anchor2');

      // Request permission for both sessions concurrently
      const p1 = pm.requestPermission('bash', 'reason1', 'sess-1');
      const p2 = pm.requestPermission('rm', 'reason2', 'sess-2');

      // Both should be dispatched to their bridges
      // Wait a microtask for async dispatch
      await new Promise((r) => setTimeout(r, 10));

      expect(b1.lastCall).not.toBeNull();
      expect(b1.lastCall!.toolName).toBe('bash');
      expect(b1.lastCall!.sessionId).toBe('sess-1');

      expect(b2.lastCall).not.toBeNull();
      expect(b2.lastCall!.toolName).toBe('rm');
      expect(b2.lastCall!.sessionId).toBe('sess-2');

      // Resolve sess-1
      pm.respond('allow', 'sess-1');
      const r1 = await p1;
      expect(r1).toBe('allow');

      // Resolve sess-2
      pm.respond('deny', 'sess-2');
      const r2 = await p2;
      expect(r2).toBe('deny');
    });
  });

  // B05: unregisterSession cleans up
  describe('unregisterSession (B05)', () => {
    it('cleans up bridge, anchor, and rejects pending requests', async () => {
      const pm = new PermissionManager();
      const bridge = makeBridge();
      pm.registerSession('sess-1', bridge, 'anchor1');

      const permPromise = pm.requestPermission('bash', 'test reason', 'sess-1');
      await new Promise((r) => setTimeout(r, 10));

      // Unregister while a request is pending
      pm.unregisterSession('sess-1');

      // The pending request should be rejected
      await expect(permPromise).rejects.toThrow('Session closed');

      // Bridge should be removed
      expect(pm.getBridge('sess-1')).toBeUndefined();

      // New requests for that session should fail
      await expect(pm.requestPermission('bash', 'test', 'sess-1')).rejects.toThrow('not registered');
    });

    it('rejects all queued requests when session is unregistered', async () => {
      const pm = new PermissionManager();
      const bridge = makeBridge();
      pm.registerSession('sess-1', bridge, 'anchor1');

      // First request occupies the current slot
      const p1 = pm.requestPermission('tool1', 'r1', 'sess-1');
      // Second request goes to queue
      const p2 = pm.requestPermission('tool2', 'r2', 'sess-1');

      await new Promise((r) => setTimeout(r, 10));

      pm.unregisterSession('sess-1');

      await expect(p1).rejects.toThrow('Session closed');
      await expect(p2).rejects.toThrow('Session closed');
    });
  });

  // Queue capacity is per-session
  describe('queue capacity per-session', () => {
    it('rejects when per-session queue exceeds MAX_QUEUE_SIZE (10)', async () => {
      const pm = new PermissionManager();
      const bridge = makeBridge();
      pm.registerSession('sess-1', bridge, 'anchor1');

      // First request occupies the current slot
      const p1 = pm.requestPermission('bash', 'reason', 'sess-1').catch(() => {}) as Promise<PermissionResponse>;
      // Queue 10 more (max = 10)
      const promises: Promise<PermissionResponse | void>[] = [p1];
      for (let i = 0; i < 10; i++) {
        promises.push(pm.requestPermission(`tool-${i}`, `reason ${i}`, 'sess-1').catch(() => {}));
      }

      // The 12th should overflow
      await expect(pm.requestPermission('overflow', 'reason', 'sess-1')).rejects.toThrow('overflow');

      // Clean up — unregister rejects all pending, but we already catch them
      pm.unregisterSession('sess-1');
      await Promise.allSettled(promises);
    });

    it('each session has its own queue capacity', async () => {
      const pm = new PermissionManager();
      const b1 = makeBridge();
      const b2 = makeBridge();
      pm.registerSession('sess-1', b1, 'anchor1');
      pm.registerSession('sess-2', b2, 'anchor2');

      // Fill sess-1 queue (1 current + up to 10 queued)
      const s1Promises: Promise<unknown>[] = [];
      s1Promises.push(pm.requestPermission('bash', 'r', 'sess-1').catch(() => {}));
      for (let i = 0; i < 10; i++) {
        s1Promises.push(pm.requestPermission(`s1-tool-${i}`, `r${i}`, 'sess-1').catch(() => {}));
      }
      await expect(pm.requestPermission('overflow', 'r', 'sess-1')).rejects.toThrow('overflow');

      // sess-2 should still accept requests (independent queue)
      const p2 = pm.requestPermission('read', 'reason', 'sess-2').catch(() => {});
      await new Promise((r) => setTimeout(r, 10));
      expect(b2.lastCall).not.toBeNull();
      expect(b2.lastCall!.toolName).toBe('read');

      // Clean up — unregister rejects all pending, but we've caught them
      pm.unregisterSession('sess-1');
      pm.unregisterSession('sess-2');
      // Wait for all caught promises to settle
      await Promise.allSettled([...s1Promises, p2]);
    });
  });

  // subscribe / unsubscribe
  describe('subscribe', () => {
    it('calls subscriber with current active request', () => {
      const pm = new PermissionManager();
      const calls: (unknown)[] = [];
      pm.subscribe((req) => { calls.push(req); });

      // TUI session should have null (no active request)
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[calls.length - 1]).toBeNull();
    });

    it('returns an unsubscribe function', () => {
      const pm = new PermissionManager();
      const unsub = pm.subscribe(() => {});
      expect(typeof unsub).toBe('function');
      unsub(); // should not throw
    });
  });

  // respond
  describe('respond', () => {
    it('resolves the current request with the given response', async () => {
      const pm = new PermissionManager();
      const bridge = makeBridge();
      pm.registerSession('sess-1', bridge, 'anchor1');

      const p = pm.requestPermission('bash', 'test', 'sess-1');
      await new Promise((r) => setTimeout(r, 10));

      pm.respond('allow', 'sess-1');
      const result = await p;
      expect(result).toBe('allow');
    });

    it('defaults to TUI session when sessionId is omitted', async () => {
      const pm = new PermissionManager();
      // Request via TUI session (sessionId 'unknown' resolves to TUI_SESSION)
      const p = pm.requestPermission('bash', 'test', 'unknown');
      await new Promise((r) => setTimeout(r, 10));

      pm.respond('always');
      const result = await p;
      expect(result).toBe('always');
    });
  });
});
