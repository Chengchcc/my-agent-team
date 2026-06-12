import type { HostToRunner, RunnerToHost } from "./messages.js";
import type { RunnerTransport } from "./transport.js";

/**
 * In-memory transport for unit tests. Two sides connected by in-process queues.
 * No socket, no serialization — messages pass by reference.
 * Delivery is synchronous within the same tick: if a listener is registered
 * before send(), the message is delivered immediately. If no listener is
 * registered, the message is queued and delivered when the first listener
 * registers.
 */
export function createMemoryTransportPair(): {
  host: RunnerTransport;
  runner: RunnerTransport;
} {
  const h2r: (HostToRunner | RunnerToHost)[] = []; // host → runner
  const r2h: (HostToRunner | RunnerToHost)[] = []; // runner → host
  let hostCb: ((msg: HostToRunner | RunnerToHost) => void) | undefined;
  let runnerCb: ((msg: HostToRunner | RunnerToHost) => void) | undefined;
  const hostCloseCbs: Array<() => void> = [];
  const runnerCloseCbs: Array<() => void> = [];
  let hostClosed = false;
  let runnerClosed = false;

  function drain(
    queue: (HostToRunner | RunnerToHost)[],
    cb: ((msg: HostToRunner | RunnerToHost) => void) | undefined,
  ) {
    if (!cb) return;
    while (queue.length > 0) {
      const msg = queue.shift()!;
      cb(msg);
    }
  }

  const host: RunnerTransport = {
    send(msg) {
      if (hostClosed || runnerClosed) return;
      h2r.push(msg);
      drain(h2r, runnerCb);
    },
    onMessage(cb) {
      hostCb = cb;
      drain(r2h, hostCb); // deliver any queued messages
    },
    onClose(cb) {
      hostCloseCbs.push(cb);
    },
    async close() {
      hostClosed = true;
      for (const cb of hostCloseCbs) cb();
    },
  };

  const runner: RunnerTransport = {
    send(msg) {
      if (hostClosed || runnerClosed) return;
      r2h.push(msg);
      drain(r2h, hostCb);
    },
    onMessage(cb) {
      runnerCb = cb;
      drain(h2r, runnerCb); // deliver any queued messages
    },
    onClose(cb) {
      runnerCloseCbs.push(cb);
    },
    async close() {
      runnerClosed = true;
      for (const cb of runnerCloseCbs) cb();
    },
  };

  return { host, runner };
}
