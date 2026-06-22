# @my-agent-team/runner-protocol

后端(backend)与 runner daemon 之间通信的传输协议。它定义了双向消息类型、NDJSON 帧格式,以及一个统一的 `RunnerTransport` 抽象,底层既可以是 Unix socket,也可以是进程内的内存管道(用于测试)。

## 为什么需要它

每个 agent 的执行其实跑在一个独立的常驻进程(runner daemon)里,而调度、持久化、对外推送都在 backend。两边必须用一套稳定的线格式说话,否则任何一方升级都会把对方搞挂。这个包就是那份契约:它把"backend 想让 daemon 做什么"和"daemon 反馈了什么"收敛成两个互斥的联合类型,并约定怎样把它们安全地切成一行一条消息塞进字节流。

传输方向是明确不对称的。daemon 是 **server**:它 `Bun.listen` 监听一个 Unix socket,并且只接受单个 backend 客户端(新连接会顶替旧连接)。backend 是 **client**:它 `Bun.connect` 主动去连,断线后按指数退避(100ms 起,封顶 5s)自动重连。这样进程重启的容错就落在了 backend 这一侧。

帧格式是 NDJSON——一个 JSON 对象占一行、UTF-8、以 `\n` 分隔。socket 上的字节不保证按消息边界到达:一个 chunk 可能只带半条消息,也可能粘了好几条。`createFramer` 负责缓冲半帧、拆分粘连帧,并对连续解析失败计数,坏帧累计到上限(默认 16)就抛错关闭,避免在脏流上无限空转。

## 核心概念

消息分两个方向。

**HostToRunner**(backend → daemon):

- `start`:开一个 run。除 `runId` 和 `spec` 外,可带 `preloadedMessages`——backend 已经把对话上下文写入 checkpointer,daemon 拿到后用它们给 agent 播种对话上下文。还可带 `surfaceContext`(仅 Lark 主 run,用于注入面向具体 surface 的额外工具)和 `trace`(从 backend 透传的 trace 上下文)。
- `abort`:取消某个 run。
- `run_finalized`:告诉 daemon 某个 run 已在 backend 侧落库完成,这是 daemon 决定是否发起反射(reflect)的触发信号。

**RunnerToHost**(daemon → backend):

- `delta`:高频增量事件流,载荷是 `event: AgentEvent`(文本/推理增量、工具开始/结束这类事件走这里)。
- `event`:非增量的离散事件,载荷同样是 `event: AgentEvent`。
- `run_started`:daemon 自己发起的反射 run 的开场白,携带 `parentRunId`、`threadId`、`kind: "reflect"` 和完整 `spec`,好让 backend 建出对应的数据库行。
- `heartbeat`:针对每个活跃 run 的存活信号。
- `run_done`:run 结束,带 `status`("succeeded" | "error" | "aborted")、可选 `wantsReflect` 和可选 `error`。
- `daemon_health`:daemon 级别的健康信号,即使空闲也定期发送,带 `uptimeMs`、`activeRunIds`、checkpointer 与 workspace 的健康状态。

所有这些消息都通过 `RunnerTransport` 接口收发:`ready()` / `send()` / `onMessage()` / `onClose()` / `close()`。socket 实现和内存实现共用这套接口,所以业务代码完全不感知底层是真 socket 还是测试管道。

## 怎么用

daemon 侧起一个 server,把收到的消息喂给业务逻辑:

```ts
import { createSocketServer } from "@my-agent-team/runner-protocol";

const { transport } = createSocketServer({ socketPath: "/tmp/agent-x.sock" });

transport.onMessage((msg) => {
  if (msg.type === "start") {
    // 用 msg.spec / msg.preloadedMessages 起 run
    transport.send({ type: "heartbeat", runId: msg.runId });
  }
});
```

backend 侧起一个 client,主动连过去并发 `start`:

```ts
import { createSocketClient } from "@my-agent-team/runner-protocol";

const transport = createSocketClient({ socketPath: "/tmp/agent-x.sock" });
await transport.ready();

transport.onMessage((msg) => {
  if (msg.type === "run_done") {
    console.log(msg.runId, msg.status, msg.wantsReflect);
  }
});

transport.send({ type: "start", runId: "run-1", spec: { /* AgentSpecV2 */ } });
```

测试里不想拉真 socket,就用进程内管道,两端拿到的还是同一套 `RunnerTransport`:

```ts
import { createMemoryTransportPair } from "@my-agent-team/runner-protocol";

const { host, runner } = createMemoryTransportPair();
```

需要手动拼帧时可直接用 `encode`(把对象变成一行 NDJSON)和 `createFramer`(把字节流还原成对象)。

## 依赖关系

依赖 `@my-agent-team/core`、`@my-agent-team/framework`(`Message`、`AgentEvent` 等类型)和 `@my-agent-team/runtime-observability`(`RuntimeTraceContext`)。被 `@my-agent-team/runner-daemon` 和 `apps/backend` 消费。
