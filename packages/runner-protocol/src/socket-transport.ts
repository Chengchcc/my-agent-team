import type { Socket } from "bun";
import type { HostToRunner, RunnerToHost } from "./messages.js";
import { parseHostToRunner, parseRunnerToHost } from "./messages.js";
import { createFramer, encode } from "./ndjson.js";
import type { RunnerTransport } from "./transport.js";

// ─── Server side (daemon listens, single backend client) ───
// Daemon receives HostToRunner frames from the backend.

export interface SocketServerOptions {
  socketPath: string;
  onError?: (err: Error) => void;
}

export function createSocketServer(opts: SocketServerOptions): {
  transport: RunnerTransport;
  server: ReturnType<typeof Bun.listen>;
  close: () => Promise<void>;
} {
  const outbound: string[] = [];
  let clientSocket: Socket<unknown> | undefined;
  const messageCbs: Array<(msg: HostToRunner | RunnerToHost) => void> = [];
  const closeCbs: Array<() => void> = [];

  const framer = createFramer(
    (obj) => {
      // M17.3 fix: validate at wire boundary instead of bare "as" cast
      try {
        const msg = parseHostToRunner(obj);
        for (const cb of messageCbs) cb(msg);
      } catch {
        opts.onError?.(new Error(`Bad HostToRunner frame: type=${(obj as { type?: string }).type ?? "unknown"}`));
      }
    },
    (line) => {
      opts.onError?.(new Error(`Bad NDJSON frame: ${line.slice(0, 80)}`));
    },
  );

  function flushOutbound(): void {
    if (!clientSocket) return;
    while (outbound.length > 0) {
      const m = outbound.shift()!;
      clientSocket.write(m);
    }
  }

  const server = Bun.listen({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        // Replace previous client (daemon expects single backend)
        clientSocket = socket;
        flushOutbound();
      },
      data(_socket, chunk) {
        framer.feed(chunk);
      },
      close() {
        clientSocket = undefined;
        for (const cb of closeCbs) cb();
      },
    },
  });

  const transport: RunnerTransport = {
    ready() {
      return Promise.resolve();
    },
    send(msg) {
      const line = encode(msg);
      if (clientSocket) {
        clientSocket.write(line);
      } else {
        outbound.push(line);
      }
    },
    onMessage(cb) {
      messageCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    async close() {
      server.stop();
      clientSocket = undefined;
      outbound.length = 0;
    },
  };

  return { transport, server, close: transport.close };
}

// ─── Client side (backend connects, reconnects with backoff) ───

export interface SocketClientOptions {
  socketPath: string;
  onError?: (err: Error) => void;
  /** Max ms to wait for first connection. Default 10_000. */
  readyTimeoutMs?: number;
}

export function createSocketClient(opts: SocketClientOptions): RunnerTransport {
  const outbound: string[] = [];
  let sock: Socket<unknown> | undefined;
  const messageCbs: Array<(msg: HostToRunner | RunnerToHost) => void> = [];
  const closeCbs: Array<() => void> = [];
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((r) => {
    resolveReady = r;
  });
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;

  // Client side (backend) receives RunnerToHost frames from the daemon.
  const framer = createFramer(
    (obj) => {
      // M17.3 fix: validate at wire boundary instead of bare "as" cast
      try {
        const msg = parseRunnerToHost(obj);
        for (const cb of messageCbs) cb(msg);
      } catch {
        opts.onError?.(new Error(`Bad RunnerToHost frame: type=${(obj as { type?: string }).type ?? "unknown"}`));
      }
    },
    (line) => {
      opts.onError?.(new Error(`Bad NDJSON frame: ${line.slice(0, 80)}`));
    },
  );

  function flushOutbound(): void {
    if (!sock) return;
    while (outbound.length > 0) {
      const m = outbound.shift()!;
      sock.write(m);
    }
  }

  async function connect(): Promise<void> {
    if (closed) return;
    let delay = 100;
    while (!closed) {
      try {
        sock = await Bun.connect({
          unix: opts.socketPath,
          socket: {
            data(_s, chunk) {
              framer.feed(chunk);
            },
            close() {
              sock = undefined;
              for (const cb of closeCbs) cb();
              if (!closed) {
                reconnectTimer = setTimeout(() => void connect(), delay);
              }
            },
          },
        });
        flushOutbound();
        resolveReady(); // first connect succeeded — transport is ready
        return;
      } catch {
        if (closed) return;
        await Bun.sleep(delay);
        delay = Math.min(delay * 2, 5000);
      }
    }
  }

  // Start connecting immediately
  void connect();

  return {
    ready() {
      clearTimeout(readyTimer);
      return Promise.race([
        readyPromise,
        new Promise<never>((_, reject) => {
          readyTimer = setTimeout(
            () => reject(new Error(`transport ready timeout after ${readyTimeoutMs}ms`)),
            readyTimeoutMs,
          );
          // Don't keep the event loop alive just for this timer
          readyTimer.unref();
        }),
      ]);
    },
    send(msg) {
      const line = encode(msg);
      if (sock) {
        sock.write(line);
      } else {
        outbound.push(line);
      }
    },
    onMessage(cb) {
      messageCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    async close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (readyTimer) clearTimeout(readyTimer);
      if (sock) {
        sock.end();
        sock = undefined;
      }
      outbound.length = 0;
    },
  };
}
