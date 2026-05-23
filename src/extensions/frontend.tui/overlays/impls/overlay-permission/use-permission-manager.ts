import { useCallback, useEffect, useState } from 'react';

export type PermissionResponse = 'allow' | 'deny' | 'always';
export interface PermissionRequest {
  toolName: string;
  reason: string;
}

interface Pending {
  request: PermissionRequest;
  resolve: (r: PermissionResponse) => void;
}

const listeners = new Set<(p: Pending | null) => void>();
let current: Pending | null = null;

export function _enqueuePermissionRequest(req: PermissionRequest): Promise<PermissionResponse> {
  return new Promise((resolve) => {
    current = { request: req, resolve };
    listeners.forEach(fn => fn(current));
  });
}

export function usePermissionManager() {
  const [pending, setPending] = useState<Pending | null>(current);

  useEffect(() => {
    const fn = (p: Pending | null) => setPending(p);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const respond = useCallback((r: PermissionResponse) => {
    const p = current;
    if (!p) return;
    current = null;
    listeners.forEach(fn => fn(null));
    p.resolve(r);
  }, []);

  const dismiss = useCallback(() => respond('deny'), [respond]);

  return { pending, respond, dismiss };
}

/** Test-only: force-resolve the current pending permission request. */
export function _respondPermissionForTest(r: PermissionResponse): void {
  if (!current) return
  const p = current
  current = null
  listeners.forEach(fn => fn(null))
  p.resolve(r)
}
