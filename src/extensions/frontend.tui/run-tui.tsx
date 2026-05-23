import { render } from 'ink';
import type { Instance as InkInstance } from 'ink';
import React from 'react';
import type { SessionClient } from './session-client';
import type { TranscriptProjector } from './transcript/projector';
import { AppV2 } from './App';
import { PasteBufferingStdin } from './paste-buffering-stdin';

export function runTUIClient(
  client: SessionClient,
  projector: TranscriptProjector,
  sessionId: string,
  snapshot?: Array<{ role: string; content: unknown }>,
): InkInstance {
  const stdin = new PasteBufferingStdin(process.stdin);
  return render(
    <AppV2 client={client} projector={projector} sessionId={sessionId} snapshot={snapshot} />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
    },
  );
}
