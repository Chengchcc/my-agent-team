import { useCallback, useEffect, useState } from 'react';

export type PermissionResponse = 'allow' | 'deny' | 'always';
export interface PermissionRequest {
  toolName: string;
  reason: string;
  input?: unknown;
  cwd?: string;
}

interface Pending {
  request: PermissionRequest;
  resolve: (r: PermissionResponse) => void;
}

const listeners = new Set<(p: Pending | null) => void>();
let queue: Pending[] = [];

function notify() {
  const current = queue[0] ?? null;
  listeners.forEach(fn => fn(current));
}

export function _enqueuePermissionRequest(req: PermissionRequest): Promise<PermissionResponse> {
  return new Promise((resolve) => {
    queue.push({ request: req, resolve });
    if (queue.length === 1) notify(); // only notify if first in queue
  });
}

export function usePermissionManager() {
  const [pending, setPending] = useState<Pending | null>(queue[0] ?? null);

  useEffect(() => {
    const fn = (p: Pending | null) => setPending(p);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const respond = useCallback((r: PermissionResponse) => {
    const p = queue.shift();
    if (!p) return;
    p.resolve(r);
    notify(); // show next in queue
  }, []);

  const dismiss = useCallback(() => respond('deny'), [respond]);

  return { pending, respond, dismiss };
}

/** Test-only: force-resolve the current pending permission request. */
export function _respondPermissionForTest(r: PermissionResponse): void {
  const p = queue.shift();
  if (!p) return;
  p.resolve(r);
  notify();
}
