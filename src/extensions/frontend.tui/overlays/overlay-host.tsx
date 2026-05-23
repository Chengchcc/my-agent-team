import React from 'react';
import { OVERLAYS } from './overlay-registry';
import type { KeyDispatcher } from '../input/key-dispatcher';

interface Props { keyDispatcher: KeyDispatcher }

export function OverlayHost({ keyDispatcher }: Props) {
  return (
    <>
      {OVERLAYS.map(descriptor => {
        const manager = descriptor.useManager();
        if (!manager.pending) return null;
        return (
          <descriptor.Component
            key={descriptor.name}
            request={manager.pending.request}
            respond={manager.respond}
            dismiss={manager.dismiss}
            keyDispatcher={keyDispatcher}
          />
        );
      })}
    </>
  );
}
