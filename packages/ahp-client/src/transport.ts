/** The WebSocket transport for AHP. Upstream's client ships only an in-memory pair, and
 *  both surfaces need this half, so it lives here once instead of twice: the protocol
 *
 *  machinery and the state mirror stay upstream. The contract is upstream's `AhpTransport`:
 *  `recv()` pulls, `send()` pushes, a clean close is `null` and an abnormal one throws. */
import type {
  AhpTransport,
  JsonRpcMessage,
  TransportFrame,
} from "@microsoft/agent-host-protocol/client";

export interface WebSocketTransportOptions {
  /** Injectable for tests; defaults to the global WebSocket. */
  readonly webSocket?: (url: string) => WebSocket;
  /** Upstream's `HostTransportFactory` contract: abort a slow handshake on teardown. */
  readonly signal?: AbortSignal;
}

/** Frame queue: socket events push, `recv()` pulls, so a small queue sits between them. */
class FrameQueue {
  readonly #frames: TransportFrame[] = [];
  readonly #waiters: Array<(frame: TransportFrame | null) => void> = [];
  #failure: Error | undefined;
  #closed = false;

  push(frame: TransportFrame | null): void {
    if (frame === null) {
      this.#closed = true;
      while (this.#waiters.length > 0) this.#waiters.shift()?.(null);
      return;
    }
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter(frame);
    else this.#frames.push(frame);
  }

  fail(error: Error): void {
    this.#failure = error;
    while (this.#waiters.length > 0) this.#waiters.shift()?.(null);
  }

  next(): Promise<TransportFrame | null> {
    if (this.#failure) return Promise.reject(this.#failure);
    const queued = this.#frames.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

export function createWebSocketTransport(
  url: string,
  options: WebSocketTransportOptions = {},
): AhpTransport {
  const open = options.webSocket ?? ((target: string) => new WebSocket(target));
  const socket = open(url);
  const frames = new FrameQueue();

  if (options.signal) {
    const abort = () => {
      frames.fail(new Error(`ahp websocket aborted: ${url}`));
      try {
        socket.close();
      } catch {
        /* never opened, or already closed */
      }
    };
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }

  socket.addEventListener("message", (event) => {
    const raw = (event as MessageEvent).data;
    if (typeof raw === "string") {
      frames.push({ kind: "text", text: raw });
      return;
    }
    if (raw instanceof Uint8Array) {
      frames.push({ kind: "binary", data: raw });
      return;
    }
    if (raw instanceof ArrayBuffer) {
      frames.push({ kind: "binary", data: new Uint8Array(raw) });
      return;
    }
    // Browsers may hand us a Blob: read it as text and enqueue it, in order.
    void (raw as Blob)
      .text()
      .then((text) => frames.push({ kind: "text", text }))
      .catch(() => undefined);
  });
  socket.addEventListener("close", () => frames.push(null));
  socket.addEventListener("error", () => frames.fail(new Error(`ahp websocket failed: ${url}`)));

  return {
    send(message: JsonRpcMessage | string): void {
      socket.send(typeof message === "string" ? message : JSON.stringify(message));
    },
    recv: () => frames.next(),
    close(): void {
      frames.push(null);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** The factory shape upstream's `MultiHostClient` expects: a fresh transport per connect
 *  (including reconnects). We have a single host, so the host id is ignored and only the
 *  abort signal is forwarded. */
export function createWebSocketTransportFactory(
  resolveUrl: (hostId: string) => string,
  options: WebSocketTransportOptions = {},
) {
  return async (hostId: string, signal: AbortSignal): Promise<AhpTransport> => {
    if (signal.aborted) throw new Error(`ahp websocket aborted before connect: ${hostId}`);
    return createWebSocketTransport(resolveUrl(hostId), { ...options, signal });
  };
}
