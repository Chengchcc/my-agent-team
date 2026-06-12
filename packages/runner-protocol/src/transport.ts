import type { HostToRunner, RunnerToHost } from "./messages.js";

/** Bidirectional message channel between backend (host) and runner daemon. */
export interface RunnerTransport {
  send(msg: HostToRunner | RunnerToHost): void;
  onMessage(cb: (msg: HostToRunner | RunnerToHost) => void): void;
  onClose(cb: () => void): void;
  close(): Promise<void>;
}
