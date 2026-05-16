import { EventEmitter } from 'node:events';

/**
 * Mock WebSocket for Lark event testing.
 * Emulates connection lifecycle and event push semantics
 * without requiring a real Lark WSClient.
 */
export class LarkWSMock extends EventEmitter {
  private connected = false;
  private reconnectSeq = 0;

  connect(): void {
    this.connected = true;
    this.reconnectSeq++;
    this.emit('connected');
  }

  disconnect(): void {
    this.connected = false;
    this.emit('disconnected');
  }

  reconnect(): void {
    this.disconnect();
    this.connect();
  }

  push(event: Record<string, unknown>): void {
    if (this.connected) {
      this.emit('event', event);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getReconnectCount(): number {
    return this.reconnectSeq;
  }

  close(): void {
    this.connected = false;
    this.removeAllListeners();
  }
}
