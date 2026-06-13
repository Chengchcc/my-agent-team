import type { HostToRunner, RunnerToHost } from "./messages.js";
import type { RunnerTransport } from "./transport.js";

export function createMemoryTransportPair(): { host: RunnerTransport; runner: RunnerTransport } {
  const h2r: (HostToRunner | RunnerToHost)[] = [];
  const r2h: (HostToRunner | RunnerToHost)[] = [];
  let hostCb: ((msg: HostToRunner | RunnerToHost) => void) | undefined;
  let runnerCb: ((msg: HostToRunner | RunnerToHost) => void) | undefined;
  const hostCloseCbs: Array<() => void> = [];
  const runnerCloseCbs: Array<() => void> = [];
  let hostClosed = false;
  let runnerClosed = false;

  function drain(
    q: (HostToRunner | RunnerToHost)[],
    cb: ((msg: HostToRunner | RunnerToHost) => void) | undefined,
  ) {
    if (!cb) return;
    while (q.length > 0) cb(q.shift()!);
  }

  const host: RunnerTransport = {
    ready() {
      return Promise.resolve();
    },
    send(msg) {
      if (hostClosed || runnerClosed) return;
      h2r.push(msg);
      drain(h2r, runnerCb);
    },
    onMessage(cb) {
      hostCb = cb;
      drain(r2h, hostCb);
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
    ready() {
      return Promise.resolve();
    },
    send(msg) {
      if (hostClosed || runnerClosed) return;
      r2h.push(msg);
      drain(r2h, hostCb);
    },
    onMessage(cb) {
      runnerCb = cb;
      drain(h2r, runnerCb);
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
