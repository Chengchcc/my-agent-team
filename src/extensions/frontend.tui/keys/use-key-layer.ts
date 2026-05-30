import { useEffect, useRef, useMemo } from 'react';
import { keyDispatcher } from '../input/key-dispatcher';
import type { KeyLayer, KeyEvent } from '../input/key-dispatcher';

export function useKeyLayer(
  layer: Omit<KeyLayer, 'id'> & { id?: string },
  deps: unknown[] = [],
): void {
  const id = useMemo(() => layer.id ?? `layer-${Math.random().toString(36).slice(2, 8)}`, []);
  const handleRef = useRef(layer.handler);
  handleRef.current = layer.handler;

  useEffect(() => {
    const wrappedHandler = (ev: KeyEvent) => handleRef.current(ev);
    keyDispatcher.push({ ...layer, id, handler: wrappedHandler });
    return () => { keyDispatcher.pop(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, layer.priority, ...deps]);
}
