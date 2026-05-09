import { debugLog } from '../utils/debug';

export class IdleGate {
  private streaming = false;
  private compacting = false;

  setStreaming(value: boolean): void {
    this.streaming = value;
  }

  setCompacting(value: boolean): void {
    this.compacting = value;
  }

  canRun(): boolean {
    const idle = !this.streaming && !this.compacting;
    if (!idle) {
      debugLog(`[evolution] IdleGate blocked: streaming=${this.streaming}, compacting=${this.compacting}`);
    }
    return idle;
  }
}
