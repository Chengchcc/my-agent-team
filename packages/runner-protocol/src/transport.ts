import type { HostToRunner, RunnerToHost } from "./messages.js";

export interface RunnerTransport {
  /** Resolves when the transport is ready to send messages. */
  ready(): Promise<void>;
  send(msg: HostToRunner | RunnerToHost): void;
  onMessage(cb: (msg: HostToRunner | RunnerToHost) => void): void;
  onClose(cb: () => void): void;
  close(): Promise<void>;
}
