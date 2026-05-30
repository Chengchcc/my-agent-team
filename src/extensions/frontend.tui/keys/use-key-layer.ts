import { useEffect, useRef, useMemo } from 'react';
import { keyDispatcher } from '../input/key-dispatcher';
import type { KeyLayer, KeyEvent } from '../input/key-dispatcher';

const RANDOM_ID_RADIX = 36;
const RANDOM_ID_LENGTH = 8;

export function useKeyLayer(
  layer: Omit<KeyLayer, 'id'> & { id?: string },
  deps: unknown[] = [],
): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const id = useMemo(() => layer.id ?? `layer-${Math.random().toString(RANDOM_ID_RADIX).slice(2, RANDOM_ID_LENGTH + 2)}`, []);
  const handleRef = useRef(layer.handler);
  handleRef.current = layer.handler;

  useEffect(() => {
    const wrappedHandler = (ev: KeyEvent) => handleRef.current(ev);
    keyDispatcher.push({ ...layer, id, handler: wrappedHandler });
    return () => { keyDispatcher.pop(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, layer.priority, ...deps]);
}
