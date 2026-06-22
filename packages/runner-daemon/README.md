# @my-agent-team/runner-daemon

一个 agent 维度的常驻沙箱进程。每个 agent 起一个 daemon,它长时间存活、在同一个进程里服务该 agent 的多个 run,并把模型/工具产生的事件流回 backend。

## 为什么需要它

如果每次 run 都新拉一个进程,冷启动成本、文件系统初始化、checkpointer 打开都要重来一遍,而且同一个 agent 的连续对话也无法复用内存里的状态。所以这里反过来:**进程随 agent 常驻,run 在进程内来去**。daemon 持有三样长生命周期的东西——一个由 `agent-fs` 提供的工作区句柄(shared / private 两个根目录),一个落在 `stateRoot/checkpointer.sqlite` 的 SQLite checkpointer,以及一个用于按 spec 造模型客户端的 `modelFactory`。这些都在 daemon 构造时建好,后续所有 run 共享。

daemon 通过 `runner-protocol` 的 `RunnerTransport` 跟 backend 对话(生产用 Unix socket,`bin.ts` 里 daemon 作为 socket server 监听)。它消费 `start` / `abort` / `run_finalized` 三类入站消息,产出 `delta` / `event` / `heartbeat` / `run_done` / `run_started` / `daemon_health` 等出站消息。

run 怎么启动取决于上下文。收到 `start` 时,daemon 先用 `AgentSpecV2` 校验 spec、核对 `agentId` 一致,再由 harness 的 `createGenericAgent` 造出 agent。关键分支在驱动阶段:`resume` 模式走 `agent.resume()`,`reflect` 模式走 `agent.run(input)`;而普通主 run 如果带了 `preloadedMessages`(backend 已经把对话上下文播进来了),就走 `agent.continue()` 而不是 `run("")`——这样避免往对话里追加一条空的用户消息,上下文又能被 checkpointer 看见。

反射(reflect)由 **daemon 自己发起,但以 backend 的信号为闸**。一个主 run 成功结束、且它的 spec 标记了需要 reflect 时,daemon 在 `run_done` 里带上 `wantsReflect: true`,并把这个 run 暂存起来;等 backend 完成落库、回发 `run_finalized` 后,daemon 才 `fork` 出一个 reflect agent、注入 `reflectionGuidance()` 作为输入、发出 `run_started` 让 backend 建行,然后驱动这个反射 run。反射 spec 会被剥掉 `surfaceContext`,确保它不继承 Lark surface 的工具。

## 核心概念

**单进程多 run。** daemon 用一个 `Map` 跟踪活跃 run,每个 run 配一个独立的 `AbortController`。`start` 时启动一次,事件按类型分流:`text_delta`、`reasoning_delta`、`tool_start`、`tool_end` 这些高频增量走 `delta` 消息,其余离散事件走 `event`。run 结束统一发 `run_done`。

**两种心跳。** 每个活跃 run 每 5 秒发一条 `heartbeat`;daemon 自身每 10 秒发一条 `daemon_health`,即使完全空闲也照发,用来让 backend 区分"进程还活着但闲着"和"进程没了"。

**surface 工具按需注入。** 仅当 `start` 带的 `surfaceContext.surface === "lark"`、声明了 `start_new_conversation` 能力、且不是 reflect 模式时,daemon 才动态加载并注入 `start_new_conversation` 工具(它会回调 backend 的 `POST /api/conversations/:id/start-new`)。

## 怎么用

通常通过 `bin.ts` 以子进程形式拉起,传入 agent id、socket 路径和三个文件根。程序内嵌入则直接 new:

```ts
import { RunnerDaemon, type ModelFactory } from "@my-agent-team/runner-daemon";
import { createSocketServer } from "@my-agent-team/runner-protocol";

const { transport } = createSocketServer({ socketPath: "/tmp/agent-x.sock" });

const modelFactory: ModelFactory = {
  create(spec) {
    // 按 spec.model / spec.baseURL 造一个能 stream() 的模型客户端
    return { stream: async function* () {} };
  },
};

const daemon = new RunnerDaemon({
  transport,
  agentId: "agent-x",
  sharedRoot: "/data/shared",
  privateRoot: "/data/private",
  stateRoot: "/data/state",
  modelFactory,
  backendUrl: "http://localhost:3000",
  backendAuthToken: null,
});

await daemon.start();
// 收到 SIGTERM/SIGINT 时:
await daemon.close();
```

`start()` 之后,daemon 就开始监听 transport 上的消息并自动驱动 run;`close()` 会停掉两个心跳定时器、中止所有在跑的 run 并关闭 transport。

## 依赖关系

依赖 `@my-agent-team/harness`(`createGenericAgent`、`reflectionGuidance`)、`@my-agent-team/agent-spec`(`AgentSpecV2`)、`@my-agent-team/framework`(checkpointer、`AgentEvent`)、`@my-agent-team/agent-fs`(工作区)、`@my-agent-team/adapter-anthropic`(`bin.ts` 里的默认模型)、`@my-agent-team/core` 和 `@my-agent-team/runner-protocol`。它是这条链路的顶层,仓库内没有其他包依赖它。
