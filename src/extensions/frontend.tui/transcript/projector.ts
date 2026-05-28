import type { DataPlaneEvent, HistoryRecordV1 } from '../../../application/contracts';
import type { TranscriptEvent } from './types';
import { dataplaneToTranscriptEvent } from './from-dataplane';
import { MAIN_SESSION_ID } from '../../../domain/anchor';

export class TranscriptProjector {
  private listeners = new Set<(event: TranscriptEvent) => void>();

  onEvent(cb: (event: TranscriptEvent) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  pushDataplaneEvent(event: DataPlaneEvent): void {
    const te = dataplaneToTranscriptEvent(event);
    if (te) {
      for (const cb of this.listeners) cb(te);
    }
  }

  loadHistory(records: HistoryRecordV1[]): void {
    for (const cb of this.listeners) {
      cb({ type: 'session_snapshot_loaded', sessionId: MAIN_SESSION_ID, records });
    }
  }

  destroy(): void {
    this.listeners.clear();
  }
}
