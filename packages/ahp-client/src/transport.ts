/** AHP 的 WebSocket 传输。上游客户端只带内存对，浏览器与 Lark 进程都需要这一段，
 *  所以放在这里共用：协议机械与状态镜像都在上游客户端里，这里不重复实现。
 *
 *  契约来自上游的 `AhpTransport`：`recv()` 是拉的、`send()` 是推的，干净关闭以
 *  `null` 表示，异常关闭以抛错表示。 */
import type {
  AhpTransport,
  JsonRpcMessage,
  TransportFrame,
} from "@microsoft/agent-host-protocol/client";

export interface WebSocketTransportOptions {
  /** 注入替身用；默认用全局 WebSocket。 */
  readonly webSocket?: (url: string) => WebSocket;
  /** 上游 `HostTransportFactory` 的契约：拆除时中止握手，别让慢握手挡住收尾。 */
  readonly signal?: AbortSignal;
}

/** 帧队列：WebSocket 事件是推的，`recv()` 是拉的，中间垫一层拉取队列。 */
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
        /* 还没打开或已经关了 */
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
    // 浏览器可以给 Blob：读成文本再入队，顺序由队列保证。
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
        /* 已经关了 */
      }
    },
  };
}

/** 上游 `MultiHostClient` 要的工厂形状：每次连接（含重连）现开一条传输。
 *  我们只有一个 host，所以这里忽略 `hostId`，只把信号转下去。 */
export function createWebSocketTransportFactory(
  resolveUrl: (hostId: string) => string,
  options: WebSocketTransportOptions = {},
) {
  return async (hostId: string, signal: AbortSignal): Promise<AhpTransport> => {
    if (signal.aborted) throw new Error(`ahp websocket aborted before connect: ${hostId}`);
    return createWebSocketTransport(resolveUrl(hostId), { ...options, signal });
  };
}
