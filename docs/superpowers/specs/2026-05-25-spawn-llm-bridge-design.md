# Spawn LLM Bridge — Bun.spawn 子进程内调用 LLM 的双向 RPC 协议 Design

- **Status**: Draft
- **Author**: Lobster Self-Learning Crew
- **Date**: 2026-05-25
- **Depends on**: `2026-05-25-self-learning-go-live-design.md`(已完成 inproc 路径 + 把默认 spawner 切到 inproc)
- **Scope**: 在 Bun.spawn 出来的 worker 子进程里复用主进程的 ProviderInvoke 能力,通过 stdio JSON-line 双向 RPC 把 `ctx.invoke({...})` 请求拉回主进程执行,worker 拿到响应后继续干活。完成后,`JOB_SPAWNER_MODE=spawn` 与 `inproc` 行为等价,主进程崩溃隔离与 CPU 隔离生效。

---

## 0. 背景与问题

self-learning-go-live spec §Q5 决议:**spawn 路径暂时 fail-fast**,默认切到 inproc。这是临时方案,有两个长期代价:

1. **隔离能力丧失**:inproc worker 与主进程共享内存与事件循环。worker 里 LLM 调用阻塞 / OOM / 死循环会拖垮主进程的对话循环。
2. **CPU 抢占**:Tier1 review + memory extract 都是 LLM 串行调用,放在主线程会和用户对话争抢 Node/Bun 事件循环时间片。

要恢复 spawn 的隔离收益,必须解决一个核心问题:**worker 子进程怎么调用 LLM**。worker 里没有 ProviderInvoke 实例,也不能直接 import 主进程的 provider chain(配置、token、rate limiter 全都在主进程的可变状态里)。

唯一干净的方案:**把 worker 的 LLM 调用通过 stdio 反向 RPC 回主进程**。本 spec 定义这套协议、超时与背压、错误恢复。

---

## 1. 设计原则

- **stdio 是契约**:worker 与主进程只通过 stdin/stdout 的 JSON-Lines (NDJSON) 通信,stderr 留给日志。绝不引入命名管道 / 共享内存 / TCP socket。
- **双向异步,单帧自洽**:每条消息一行 JSON,带 `id` 与 `kind`,接收方按 id 匹配请求/响应。不假设顺序。
- **主进程是 RPC 服务端**:worker 启动后,可以发起 `invoke-req`、`log`,主进程响应 `invoke-resp` / `error`。反之主进程也可以发 `shutdown`。
- **超时硬约束**:每个 invoke-req 默认 60s 超时,worker 整体生命周期默认 300s 超时,双层防护。
- **背压**:同一 worker 内 invoke-req 并发上限 1(LLM 调用本身是同步链路,worker 也不应并发请求)。

---

## 2. 协议帧

所有帧统一结构:

```ts
interface Frame {
  v: 1                            // 协议版本
  id: string                      // uuidv4
  kind: FrameKind
  ts: number                      // 发送时戳(ms)
  payload: unknown
}

type FrameKind =
  | 'init'             // 主→worker:初始化参数
  | 'invoke-req'       // worker→主:请求 LLM 调用
  | 'invoke-resp'      // 主→worker:LLM 响应
  | 'result'           // worker→主:job 结果
  | 'log'              // worker→主:日志
  | 'shutdown'         // 主→worker:请求退出
  | 'error'            // 双向:错误
```

### 2.1 init(主→worker,第一帧)

```json
{ "v":1, "id":"...", "kind":"init", "ts":...,
  "payload": {
    "jobType": "evolution.review" | "memory.extract",
    "job": { ... },                      // 原始 job 对象,序列化后传入
    "config": { "invokeTimeoutMs": 60000 }
  }
}
```

worker 收到 `init` 后开始执行 handler,handler 内通过 `ctx.invoke(...)` 发起 `invoke-req`。

### 2.2 invoke-req(worker→主)

```json
{ "v":1, "id":"req-uuid", "kind":"invoke-req", "ts":...,
  "payload": {
    "purpose": "evolution-review-tier1",
    "messages": [ {"role":"system","content":"..."}, {"role":"user","content":"..."} ],
    "maxTokens": 800,
    "parentTurnId": "evolution-review:run-xxx"   // 由 §5 工厂注入
  }
}
```

### 2.3 invoke-resp(主→worker)

```json
{ "v":1, "id":"req-uuid", "kind":"invoke-resp", "ts":...,
  "payload": {
    "content": "...",
    "usage": { "input": 1234, "output": 567 }
  }
}
```

`id` 必须等于对应 `invoke-req` 的 `id`。worker 内有 `pending: Map<id, {resolve, reject, timer}>`。

### 2.4 result(worker→主,最后一帧)

```json
{ "v":1, "id":"...", "kind":"result", "ts":...,
  "payload": { ... }                  // handler 返回值,例如 { verdict, evidence }
}
```

发完 `result` 后 worker 主动 `process.exit(0)`。

### 2.5 log(worker→主)

```json
{ "v":1, "id":"...", "kind":"log", "ts":...,
  "payload": { "level":"info"|"warn"|"error"|"debug", "msg":"...", "extra": {...} }
}
```

主进程把它转发到自己的 logger,带 `[worker pid=...]` 前缀。

### 2.6 shutdown(主→worker)

```json
{ "v":1, "id":"...", "kind":"shutdown", "ts":...,
  "payload": { "reason": "timeout"|"parent-shutdown"|"cancel" }
}
```

worker 收到后:取消所有 pending invoke,emit 一条 `error` 帧告知,然后 5s 内退出。超时则被主进程 `kill SIGKILL`。

### 2.7 error(双向)

```json
{ "v":1, "id":"req-or-arbitrary", "kind":"error", "ts":...,
  "payload": {
    "code": "TIMEOUT" | "PROVIDER_FAIL" | "DECODE_ERROR" | "INTERNAL",
    "message": "...",
    "cause"?: "..."
  }
}
```

若 `id` 对应某条 `invoke-req`,worker 把它当作该 invoke 的失败响应;否则视为致命错误,worker exit(1)。

---

## 3. 编解码

NDJSON:每帧 JSON 后跟一个 `\n`。读取侧用按行缓冲解析。

工具函数:

```ts
// src/infrastructure/jobs/spawn-rpc/frame.ts
export function encodeFrame(f: Frame): string {
  return JSON.stringify(f) + '\n'
}

export class FrameDecoder {
  private buf = ''
  push(chunk: string | Buffer): Frame[] {
    this.buf += chunk.toString('utf8')
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    return lines
      .filter(l => l.length > 0)
      .map(l => {
        try { return JSON.parse(l) as Frame } catch { return null }
      })
      .filter((f): f is Frame => f !== null && f.v === 1)
  }
}
```

容错:无效行直接丢弃 + 计数器 `frame.decode.failed++`。超过 10 次连续失败,主进程发 `shutdown` 并 kill。

---

## 4. 主进程侧:BunSpawnJobSpawner 重写

```ts
class BunSpawnJobSpawner implements JobSpawner {
  constructor(
    private invoke: ProviderInvoke,
    private logger: Logger,
    private cfg: SpawnConfig,
  ) {}

  async handle<TJob, TResult>(
    job: TJob,
    ctx: { jobType: string; parentTurnIdFactory: (req: InvokeReq) => string },
  ): Promise<TResult> {
    const child = Bun.spawn({
      cmd: ['bun', 'run', this.cfg.workerEntryPath, ctx.jobType],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    })

    const decoder = new FrameDecoder()
    const lifetimeTimer = setTimeout(
      () => this.killWith(child, 'lifetime-timeout'),
      this.cfg.lifetimeMs,
    )

    // 发 init
    child.stdin.write(encodeFrame({
      v: 1, id: uuid(), kind: 'init', ts: Date.now(),
      payload: { jobType: ctx.jobType, job, config: { invokeTimeoutMs: this.cfg.invokeTimeoutMs } },
    }))

    const reader = child.stdout.getReader()
    let resultFrame: Frame | null = null

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      for (const frame of decoder.push(value)) {
        switch (frame.kind) {
          case 'invoke-req':
            await this.handleInvokeReq(frame, child, ctx.parentTurnIdFactory)
            break
          case 'log':
            this.relayLog(frame, child.pid)
            break
          case 'result':
            resultFrame = frame
            break
          case 'error':
            throw new Error(`worker error: ${JSON.stringify(frame.payload)}`)
        }
      }

      if (resultFrame) break
    }

    clearTimeout(lifetimeTimer)
    await child.exited  // 等 worker 自己退
    if (!resultFrame) throw new Error('worker exited without result')
    return resultFrame.payload as TResult
  }

  private async handleInvokeReq(
    req: Frame,
    child: Bun.Subprocess,
    parentTurnIdFactory: (r: InvokeReq) => string,
  ): Promise<void> {
    const payload = req.payload as InvokeReq
    const parentTurnId = parentTurnIdFactory(payload)

    const timer = setTimeout(() => {
      child.stdin.write(encodeFrame({
        v: 1, id: req.id, kind: 'error', ts: Date.now(),
        payload: { code: 'TIMEOUT', message: `invoke timeout after ${this.cfg.invokeTimeoutMs}ms` },
      }))
    }, this.cfg.invokeTimeoutMs)

    try {
      const resp = await this.invoke({
        purpose: payload.purpose,
        messages: payload.messages,
        maxTokens: payload.maxTokens,
        parentTurnId,
      })
      clearTimeout(timer)
      child.stdin.write(encodeFrame({
        v: 1, id: req.id, kind: 'invoke-resp', ts: Date.now(),
        payload: { content: resp.content, usage: resp.usage },
      }))
    } catch (err) {
      clearTimeout(timer)
      child.stdin.write(encodeFrame({
        v: 1, id: req.id, kind: 'error', ts: Date.now(),
        payload: { code: 'PROVIDER_FAIL', message: (err as Error).message },
      }))
    }
  }

  private killWith(child: Bun.Subprocess, reason: string): void {
    child.stdin.write(encodeFrame({
      v: 1, id: uuid(), kind: 'shutdown', ts: Date.now(),
      payload: { reason },
    }))
    setTimeout(() => { try { child.kill(9) } catch {} }, 5000)
  }
}
```

---

## 5. worker 侧 runtime helper

新增 `src/infrastructure/jobs/spawn-worker-runtime.ts`,被 `worker-entry.ts` 引用:

```ts
export async function runWorker(handler: (job: any, ctx: JobContext) => Promise<unknown>) {
  const decoder = new FrameDecoder()
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: Timer }>()
  let initFrame: Frame | null = null

  const writeFrame = (f: Frame) => { process.stdout.write(encodeFrame(f)) }

  const ctx: JobContext = {
    invoke: (req) => new Promise((resolve, reject) => {
      const id = uuid()
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('local invoke timeout'))
      }, 65_000)
      pending.set(id, { resolve, reject, timer })
      writeFrame({ v: 1, id, kind: 'invoke-req', ts: Date.now(), payload: req })
    }),
    log: (level, msg, extra) => {
      writeFrame({ v: 1, id: uuid(), kind: 'log', ts: Date.now(),
        payload: { level, msg, extra } })
    },
  }

  process.stdin.on('data', async (chunk) => {
    for (const frame of decoder.push(chunk)) {
      switch (frame.kind) {
        case 'init':
          initFrame = frame
          ;(async () => {
            try {
              const result = await handler((frame.payload as any).job, ctx)
              writeFrame({ v: 1, id: uuid(), kind: 'result', ts: Date.now(), payload: result })
              process.exit(0)
            } catch (err) {
              writeFrame({ v: 1, id: uuid(), kind: 'error', ts: Date.now(),
                payload: { code: 'INTERNAL', message: (err as Error).message } })
              process.exit(1)
            }
          })()
          break

        case 'invoke-resp':
          {
            const p = pending.get(frame.id)
            if (p) { clearTimeout(p.timer); pending.delete(frame.id); p.resolve(frame.payload) }
          }
          break

        case 'error':
          {
            const p = pending.get(frame.id)
            if (p) {
              clearTimeout(p.timer); pending.delete(frame.id)
              p.reject(new Error(JSON.stringify(frame.payload)))
            }
          }
          break

        case 'shutdown':
          for (const [, p] of pending) {
            clearTimeout(p.timer); p.reject(new Error('shutdown'))
          }
          setTimeout(() => process.exit(0), 100)
          break
      }
    }
  })
}
```

`worker-entry.ts` 简化为:

```ts
import { runWorker } from '../../infrastructure/jobs/spawn-worker-runtime'
import { handleReview } from './handler'

runWorker(handleReview)
```

---

## 6. 与 inproc spawner 的接口对齐

inproc spawner 也升级为 `handle(job, ctx)`,其内部直接调用 handler 时传入一个简化的 ctx:

```ts
const inprocCtx: JobContext = {
  invoke: (req) => this.invoke({
    ...req,
    parentTurnId: ctx.parentTurnIdFactory(req),
  }),
  log: (level, msg, extra) => this.logger[level](msg, extra),
}
return handler(job, inprocCtx)
```

这样 handler 代码完全不感知是 inproc 还是 spawn,实现可替换。

---

## 7. 配置

```ts
// src/config/defaults.ts
jobs: {
  spawner: {
    mode: 'inproc',                        // 切到 'spawn' 启用本 spec
    workerEntryPath: './dist/worker-entry.js',
    invokeTimeoutMs: 60_000,
    lifetimeMs: 300_000,
    maxConcurrent: 2,                      // 主进程并发跑几个 worker
  }
}
```

`JOB_SPAWNER_MODE=spawn` 环境变量覆盖 `mode`,便于 ops 切换。

---

## 8. 故障模式与对策

| 故障                           | 检测                          | 对策                                      |
|--------------------------------|------------------------------|------------------------------------------|
| worker 启动失败 (exit code ≠ 0) | `child.exited` 立即 resolve  | throw,evolution/memory subscriber 计 fail |
| worker 卡死,不发任何帧         | `lifetimeMs` 超时            | 发 shutdown → 5s 后 SIGKILL              |
| 单个 invoke 超时               | `invokeTimeoutMs`            | 主进程发 error 帧,worker 内 reject promise |
| stdout 解析失败                | FrameDecoder 计数            | 连续 10 次 → shutdown + kill              |
| 主进程崩溃                     | worker 检测 stdin EOF         | worker 取消 pending,5s 后自杀             |
| worker 崩溃                    | `child.exited` 早于 result   | throw 'worker exited without result'     |

---

## 9. 安全

- worker 仅有 stdio,没有网络/文件权限假设(由部署环境的进程权限管控)。
- `invoke-req.purpose` 必须在主进程的白名单内 (`evolution-review-tier1` / `memory-extract-tier1`),其它值直接 reject。防止 worker 被"恶意"修改后发起任意 LLM 请求。
- `messages` 大小硬上限 128KB,超出直接 reject。
- 主进程 logger 输出 worker 日志时,统一打 `[worker:${jobType}:pid=${pid}]` 前缀,审计可追溯。

---

## 10. 可观测性

新事件:

| 事件                       | payload                                |
|---------------------------|----------------------------------------|
| `spawn.worker.started`    | `{ jobType, pid }`                     |
| `spawn.worker.invoke`     | `{ jobType, pid, purpose, latencyMs }` |
| `spawn.worker.exited`     | `{ jobType, pid, code, durationMs }`   |
| `spawn.worker.killed`     | `{ jobType, pid, reason }`             |
| `spawn.worker.frame-fail` | `{ pid, raw }`(限频,每 worker 最多 3 条) |

trace 系统已能持久化这些事件,后续可在 dashboard 看 worker 健康度。

---

## 11. 灰度切换

1. 先在 staging 把 `mode='spawn'` 跑一周,观察 `spawn.worker.killed` 频率与 `invoke` p99 延迟。
2. 若 killed 频率 < 1%、p99 延迟与 inproc 相比上浮 < 200ms,在 prod 灰度 10% agent 实例。
3. 全量切换后,inproc spawner **保留**,作为 `mode='inproc'` 可选项(单机调试 / e2e 测试更方便)。

---

## 12. 验收清单

- [ ] worker 启动后能成功完成一次 `ctx.invoke(...)`,返回内容能被主进程 ProviderInvoke 看到 (trace 里有对应 LLM 调用)
- [ ] worker handler 抛错时,主进程能拿到 `'INTERNAL'` 错误帧并 fail 当前 job
- [ ] `invoke-req` 在 `invokeTimeoutMs` 内未响应,worker 内 promise reject 且不挂起
- [ ] worker 进程跑过 `lifetimeMs` 仍未发 result,被主进程发 shutdown,5s 后 SIGKILL
- [ ] 主进程中途崩溃模拟 (kill -9 parent),worker 在 stdin EOF 后 5s 内自杀
- [ ] `inproc` 与 `spawn` 模式下,evolution.review 与 memory.extract 的输出在同一 job 上字节级一致(序列化决定论)
- [ ] purpose 白名单检查:伪造 `purpose='unauthorized'` 的 invoke-req 被主进程返回 error 帧
- [ ] 在 staging 连续跑 100 个 review job,无 worker 泄漏(`ps` 查不到僵尸进程)
