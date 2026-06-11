# EventLog — 执行事件的单一事实源（Durable Runs 的地基）

> EventLog 是一个**独立 port**，把"run 执行产生的事件流"从 [Checkpointer](./04-checkpointer.md) 里**剥离**出来，成为一个**只追加、可投影、可订阅**的事实源。
>
> 它解决的第一性问题:**执行**(run 子进程推进)、**投影**(SSE 推给前端)、**HTTP 连接生命周期**三者必须正交。run 子进程把事件**写**进 EventLog;backend 的 SSE 端从 EventLog **读**;两者互不认识,只通过 EventLog 通信。客户端断连、backend 重启都不影响执行——因为执行者从不向"连接"写,只向 EventLog 写。
>
> 关联:[04-checkpointer](./04-checkpointer.md)(职责对照) · [12-backend](./12-backend.md)(投影端) · [13-agent-spec](./13-agent-spec.md)(注入契约)。

---

## 一、为什么从 Checkpointer 里拆出来

事件流若挂在 Checkpointer 的 Tier 3(`appendEvent` / `readEvents`),在单进程 CLI 下没问题,但 durable runs 要求把它独立,原因是**两者的职责维度根本不同**:

| 维度 | Checkpointer | EventLog |
|---|---|---|
| **服务对象** | agent loop 自己(崩溃后续跑) | UX / 审计 / SSE 投影(人看的) |
| **数据形态** | messages **快照**(可覆盖、有 interrupt 状态机) | 事件**追加流**(只 append,永不更新) |
| **读取粒度** | 按 `threadId` 取最新快照 | 按 `runId` **或** `threadId`,带 `afterSeq` 增量续读 |
| **注入者** | **runner**(子进程内,backend 不碰) | **backend** composition root(投影端要读它) |
| **可订阅** | 否(load 一次性返回) | **是**(tail 新事件,SSE 长连接消费) |
| **生命周期** | 与 thread 绑定 | 与 run 绑定(但带 thread_id 可聚合) |

> **关键矛盾(若不拆的设计债)**:如果事件流继续留在 Checkpointer,那 backend 的 SSE 投影端就**必须持有 Checkpointer**——但 Checkpointer 的定位是"runner 注入、backend 不碰"(见 [04 §已知限制](./04-checkpointer.md#已知限制sandbox-隔离),沙箱化后 backend 根本拿不到 runner 的 checkpointer handle)。这是个无解的耦合。
>
> **拆出 EventLog 并给它一个 `thread_id` 字段后,矛盾消失**:backend 投影端只持有 EventLog,既能按 `runId` 投影单次 run,又能按 `threadId` 回放整个会话历史,**永远不需要碰 Checkpointer**。

---

## 二、解耦铁律

EventLog 的所有设计都从这四条推导,违反任一条都会把耦合带回来:

1. **依赖指向抽象,存储细节封死在 adapter** — framework / backend 只认 `EventLog` 接口;Postgres 的 `LISTEN/NOTIFY`、SQLite 的轮询、序列号生成方式,全部封死在各自 adapter 里。换存储 = 换一个 adapter 实现,上层零改动。
2. **tail 是 EventLog 的读对偶,不是执行者的能力** — "订阅新事件"(`subscribe`)是 EventLog 接口的一部分,不是 runner 或 backend 的附加能力。谁想 tail 就向 EventLog 要,不需要知道事件是谁写的、写在哪。
3. **执行者与投影者互不认识** — run 子进程(执行者)只调 `append`;backend SSE(投影者)只调 `read` + `subscribe`。两者没有任何直接引用,唯一的通信媒介是 EventLog。子进程崩了、backend 重启了,另一方都无感知——因为事实源在 EventLog,不在内存、不在连接。
4. **执行者只向最持久层写,绝不依赖 backend 转发** — run 子进程**直写 EventLog**(事实源),不走"stdout → backend → EventLog"的转发链。一旦依赖 backend 转发,backend 死即事件断流,"backend 重启重新发现"就不成立。stdout 仅作可选的低延迟通知通道,**断了不丢事件**。这是整个 durable 性质的地基,不可妥协。

> 四条铁律的共同方向:**一切真相沉到生命周期最长的那一层(DB),短生命周期对象(SSE 连接、backend 进程、run 子进程)之间不直接耦合,只通过持久层派生/投影**。见 [§十 生命周期审视](#十生命周期审视架构洁净度的判据)。

---

## 三、接口设计

port 仍叫 **`EventLog`**(它就是"执行事件的日志"这一事实源,名字最准确)。语义不堆在 port 名上,而是**落在读写两侧的角色接口名上**——`EventLog` 由两个窄接口组合而成,消费者只引用与自己角色匹配的那一个,名字即说明"我在这条日志上扮演什么":

```ts
/** 单条已落库事件:业务事件 + 单调递增序号 + 归属 */
interface EventRecord {
  seq: number;            // 全局单调递增主键(SSE 的 Last-Event-ID 即此值)
  threadId: string;       // 归属 thread —— 支持按会话聚合回放
  runId: string;          // 归属 run   —— 支持按单次执行投影
  event: AgentEvent;      // 业务事件本体(message / interrupted / ...)
  ts: number;
}

interface ReadQuery {
  /** 二选一:按 run 投影,或按 thread 回放整段会话 */
  runId?: string;
  threadId?: string;
  /** 增量续读:只返回 seq > afterSeq 的事件(SSE Last-Event-ID 续读) */
  afterSeq?: number;
  limit?: number;
}

/** 写侧:事件的生产者(run 子进程)。只能 append,语义即"我是事件的来源" */
interface EventSink {
  /** 追加一条事件,返回分配的 seq。append-only,永不更新 */
  append(threadId: string, runId: string, event: AgentEvent): Promise<number>;
}

/** 读侧:事件的投影者(backend SSE / 审计 / 回放)。只能读,语义即"我消费日志" */
interface EventSource {
  /** 一次性读取(冷读 / 回放历史)。run 早已结束也能读 */
  read(query: ReadQuery): Promise<EventRecord[]>;
  /** 订阅 tail 新事件。回放 afterSeq 之后的历史 → 持续推送新事件 */
  subscribe(query: ReadQuery, signal?: AbortSignal): AsyncIterable<EventRecord>;
}

/** 完整 port = 写侧 + 读侧。adapter 实现它;消费者只引用 EventSink 或 EventSource */
interface EventLog extends EventSink, EventSource {}
```

> **命名落在读写方,而非 port 名**:`EventLog` 是中性的事实源名;`EventSink`(写/汇)与 `EventSource`(读/源)在**类型签名层面**就把角色写死了。run 子进程的 entry 拿到的是 `EventSink`——编译器不让它 `subscribe`;backend 投影端拿到的是 `EventSource`——编译器不让它 `append`。误用在编译期即被堵死(接口隔离原则),无需运行时约定。

### 两侧角色与方法分工

| 角色接口 | 方法 | 谁拿到 | 何时用 |
|---|---|---|---|
| **`EventSink`**(写侧) | `append` | **run 子进程**(执行者) | 每产生一个 AgentEvent |
| **`EventSource`**(读侧) | `read` | backend 投影端 | 冷读已结束的 run / 回放 thread 历史 / SSE 重连时回放 `afterSeq` 之前 |
| **`EventSource`**(读侧) | `subscribe` | backend 投影端 | SSE 长连接,先回放历史再 tail 新事件 |

> `read` 与 `subscribe` 的关系:`subscribe` = `read`(回放历史)+ 持续 tail。SSE 端点用 `subscribe` 一个方法就能覆盖"重连续读 + 实时推送";纯历史导出用 `read`。

---

## 四、内置实现

### 4.1 `postgresEventLog`(默认,生产形态)

**直连 PostgreSQL**(`postgres.js`,不用任何 BaaS SDK),tail 用 `LISTEN/NOTIFY` 实时推 + 轮询兜底。

```sql
CREATE TABLE event_log (
  seq        BIGSERIAL PRIMARY KEY,         -- 全局单调,SSE id
  thread_id  TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  event      JSONB NOT NULL,
  ts         BIGINT NOT NULL
);
CREATE INDEX idx_event_log_run    ON event_log(run_id, seq);
CREATE INDEX idx_event_log_thread ON event_log(thread_id, seq);
```

- **append**:`INSERT ... RETURNING seq` → 同事务 `pg_notify('event_log', json_build_object('runId', run_id, 'seq', seq))`。
- **subscribe**:`SELECT ... WHERE run_id=$1 AND seq > $afterSeq ORDER BY seq`(回放)→ 然后 `LISTEN event_log`,收到通知按 `runId` 过滤、按 `seq` 去重推送;**轮询兜底**(每 `pollMs` 查一次 `seq > 高水位`),覆盖跨进程 / backend-重启 / NOTIFY 丢失场景。
- **去重**:投影端维护"已发出的最大 seq"水位,LISTEN 推送与轮询结果按 seq 去重,保证不重不漏。

> **为什么直连而非 BaaS SDK**:tail 能力(LISTEN/NOTIFY)是 EventLog 接口内部实现细节,封死在 adapter。换 BaaS 或换自建 PG = 换 adapter,上层零感知(铁律 1)。直连给了我们对连接池、事务、NOTIFY 的完全掌控,不被 SDK 的封装绑架。

### 4.2 `sqliteEventLog`(本地 dev / 单机)

SQLite 无 LISTEN/NOTIFY,tail 退化为**纯轮询**(`seq > 高水位`,默认 250ms)。

```sql
CREATE TABLE event_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  event      TEXT NOT NULL,   -- JSON
  ts         INTEGER NOT NULL
);
CREATE INDEX idx_event_log_run    ON event_log(run_id, seq);
CREATE INDEX idx_event_log_thread ON event_log(thread_id, seq);
```

- **append-only + WAL + `busy_timeout`**:支持"run 子进程与 backend 并发写同库"。append-only 让冲突面最小(无更新、无删除)。
- 接口与 `postgresEventLog` 完全一致——backend 切换存储只改 composition root 一行 `new`。

### 4.3 `inMemoryEventLog`(测试)

进程内数组 + EventEmitter。`subscribe` 用 EventEmitter 推 tail。进程退出即丢,接口完整,保证测试行为统一。

---

## 五、与 Checkpointer 的职责切分(对照表)

两者职责彻底分家。**一个事件可能同时触发两者**,但写入路径完全独立:

| 关注点 | Checkpointer | EventLog |
|---|---|---|
| agent 崩溃后从 tool 边界续跑 | ✅ `save`/`load` 快照 | ❌ |
| human-in-the-loop 暂停/恢复 | ✅ `saveInterrupt`/`consumeInterrupt` | ❌ |
| UX 时间轴回放 / SSE 投影 | ❌(不承担) | ✅ `read`/`subscribe` |
| 谁注入 | runner(子进程,通过 AgentSpec) | backend composition root |
| backend 是否持有 | **否**(沙箱化后拿不到) | **是**(投影端唯一数据源) |

> **04-checkpointer.md 的 Tier 3(`appendEvent`/`readEvents`)语义降级**:它仍可作为"checkpointer 内部审计"保留,但**不再是 UX 投影的数据源**。UX 投影一律走 EventLog。framework 在 run 推进时,事件**同时**喂给(可选的)checkpointer Tier 3 与 EventLog;后者才是 backend 投影的事实源。

### 5.1 为什么 EventLog 不能取代 Checkpointer 做 resume

直觉上 EventLog 记了完整事件流,似乎能 replay 出 messages、省掉 checkpointer。**技术上能 replay(event sourcing 的 fold),但不能作为 resume 的权威源**,因为:

| 障碍 | 说明 |
|---|---|
| **裁剪信息丢失(致命)** | EventLog 记的是**原始事件**(完整 `model_end` / `tool_end`);agent loop 真正喂给模型的是**裁剪/摘要后**的 messages(token-budget / summarizing / sliding-window)。从 EventLog replay 得到的是未裁剪全量历史,与 checkpointer `save` 存的"裁剪后真实输入态"**分叉**——用它 resume 轻则 token 爆,重则 Anthropic 400(tool 对被裁断)。 |
| **interrupt 是消费语义** | checkpointer Tier 2 的 `consumeInterrupt` 是"读取即删除"的状态机(防双消费);EventLog 是 append-only,没有 consume 概念,重建 pending interrupt 要扫到最后一个未被 `resume` 跟随的 `interrupt` 事件,脆弱且易错。 |

**结论(定为不变量)**:
- **checkpointer = resume 的唯一权威源**(只有它存了裁剪后的真实输入态)。
- **EventLog = 观测/审计/投影的唯一权威源**(只有它存了完整未裁剪事件)。
- 两者从 agent loop 同一时刻派生,但**投影目标不同,不互为上游,不可互相替代**。

> **未来演进**:若想去掉 checkpointer 快照、纯 event-sourced,需要 EventLog 额外记录"每步裁剪后的输入态摘要"作为新事件类型,让 replay 能还原裁剪态。这是一次架构升级(真正的 event-sourced agent),当前不做,标为可演进方向。

---

## 六、写入路径:谁产生事件 vs 谁写 EventLog

**关键澄清:harness / framework 不认识 EventLog,不写 EventLog。** 职责分三层,不可混淆:

| 角色 | 职责 | 拿到哪一侧接口 |
|---|---|---|
| harness `agent.run()` / `agent.resume()` | **yield** `AsyncIterable<AgentEvent>` | ❌ 无——只产生事件,不知道去哪 |
| **runner entry**(子进程边界层) | 消费 yield,`append` 落库 | ✅ **写侧 `EventSink`**(编译器只允许 `append`) |
| backend 投影端 | `subscribe` 读、tail 推送 | ✅ **读侧 `EventSource`**(编译器只允许 `read`/`subscribe`) |

这与 [12-backend §runner entry](./12-backend.md) 的"entry 只做反序列化 spec → 装配 agent → 序列化 event 三件事"原则一致——只是把第三件事从"序列化到 stdout"升级为"`append` 到 EventLog(+ 可选 stdout 通知)"。**EventLog 停在 entry 层,绝不下沉到 harness/framework**——下沉就是把投影耦合带回内核,正是 04-checkpointer Tier 3 当年的毛病。

durable runs 的核心要求是**"backend 死了,run 子进程还能继续写"**(铁律 4)。因此:

- run 子进程的 **entry** 自己持有写侧 `EventSink`(经 AgentSpec 注入连接配置构造),每个 yield 出来的事件 `append` 落库。
- backend 的 RunSupervisor 解析子进程 stdout 仅作**低延迟通知通道**(可选优化),**DB 才是事实源**。
- backend 活着:stdout 通知 → 投影端快速推送;backend 死了:子进程 entry 仍在 `append`,backend 重启后 `subscribe(afterSeq=高水位)` 补齐。**stdout 丢失绝不丢事件**。

```ts
// runner entry:append 在前,writeEvent 在后 —— DB 是事实源,stdout 丢了不丢事件
const sink: EventSink = makeEventLog(spec.storage.eventLog); // 据连接配置自建 adapter,只取写侧
const stream = spec.mode === "resume"
  ? agent.resume(spec.resumeCommand, { signal, maxSteps })
  : agent.run(spec.input, { signal, maxSteps });
for await (const ev of stream) {
  await sink.append(spec.threadId, spec.runId, ev);       // 事实源(写侧只能 append)
  writeEvent(ev);                                          // 可选低延迟通知
}
```

```
run 子进程 entry(执行者)          EventLog(事实源)          backend(投影者)
      │ append(thread,run,evt) ───────►│
      │                                │◄─── subscribe(runId, afterSeq) ───┐
      │                                │      回放历史 + tail 新事件        │
      │ (backend 死)                   │                                   │
      │ append 继续 ──────────────────►│   (backend 重启)                  │
      │                                │◄─── subscribe 补齐 ───────────────┘
```

> ⚠️ 设计后果:子进程与 backend 可能并发写同一 DB。SQLite 靠 `busy_timeout` + WAL + append-only;Postgres 天然支持并发写。这是实现首阶段需要基准压测验证的点。

---

## 七、SSE 投影映射(backend 侧)

backend 的 `GET /api/runs/:id/events` 端点是 EventLog 的**只读投影**,机械映射,无业务逻辑:

```ts
// 请求头 Last-Event-ID: <seq> → afterSeq
for await (const rec of eventLog.subscribe({ runId, afterSeq }, req.signal)) {
  res.write(`id: ${rec.seq}\nevent: ${rec.event.type}\ndata: ${JSON.stringify(rec.event)}\n\n`);
}
// run 终态后合成 event: done(复用 infra/sse.ts)
```

- 客户端断开 → `subscribe` 的 `AbortSignal` 触发 → **只取消订阅,不 abort run**(执行者无感知,铁律 3)。
- 冷读(run 已结束):`subscribe` 回放完历史后立即遇终态 → 合成 done → 关闭。等价于纯 `read`。

详见 [12-backend.md](./12-backend.md)。

---

## 八、依赖方向

```
framework ──→ core(EventLog 接口定义在 core 或独立 port 包)
backend ─────→ EventLog 接口
postgresEventLog / sqliteEventLog / inMemoryEventLog ──→ core(实现接口)

backend(composition root)──new──► postgresEventLog   (唯一实例化点)
run 子进程(经 AgentSpec 注入连接配置)──► 同一 EventLog 实现
```

- 接口定义不依赖任何 adapter(铁律 1)。
- backend `main.ts` 是**唯一** `new postgresEventLog(...)` 的地方(composition root);其余代码只见接口。
- run 子进程通过 AgentSpec 拿到 EventLog 的**连接配置**(不是 handle,跨进程传不了 handle),自己构造同种 adapter。

### 8.1 port 分离,但 adapter 可合一

EventLog 与 Checkpointer 是**两个独立 port**(接口必须分,理由见 [§一](#一为什么从-checkpointer-里拆出来));但**具体实现层完全可以由同一个 adapter 类同时实现两个接口、共享一个连接池**:

```ts
class PostgresStore implements EventLog, Checkpointer {
  constructor(private sql: Sql) {}        // 共享同一个 postgres.js 连接池
  // EventLog 子集
  async append(...) {} async read(...) {} async *subscribe(...) {}
  // Checkpointer 子集
  async save(...) {} async load(...) {} async saveInterrupt(...) {} async consumeInterrupt(...) {}
}
```

消费者通过**窄接口类型**各拿能力子集,编译期堵死误用(接口隔离原则)。EventLog 这侧进一步用读写角色名收窄——写侧拿 `EventSink`,读侧拿 `EventSource`(见 [§三](#三接口设计)):

```ts
const store = new PostgresStore(sql);
const eventSink: EventSink = store;       // runner 子进程:只见 append
const eventSource: EventSource = store;   // backend 投影端:只见 read/subscribe
const checkpointer: Checkpointer = store; // runner 子进程:只见 save/load/...
```

> "同一 adapter 实现多套方法" = 实现复用;"消费者只见接口子集(`EventSink`/`EventSource`/`Checkpointer`)" = 解耦保证。两者不冲突。注意跨进程时"同一个 adapter"指**同一个类**,不是同一个对象——run 子进程与 backend 各自 `new` 一个,连同一个后端存储。

### 8.2 不变量:EventLog 收敛,Checkpointer 可异构

durable runs 下不同 runner 可以用**不同介质的 checkpointer**(Runner A 用 sqlite、B 用 redis、C 用 memory)——这是各 run 子进程**进程内的事**,由 `AgentSpec.storage.checkpointer` 决定,**backend 既看不到也不需要处理**(backend 不持有 checkpointer)。

但 EventLog 不能异构:

> **不变量(EventLog 收敛)**:所有 runner 的 `storage.eventLog` 必须由 **backend 下发**、指向 **backend 也能连的同一后端存储**(同一 PG 实例 / 同一 SQLite 文件)。否则 backend 投影端 `subscribe({runId})` 找不到事件。
>
> 即:**`storage.eventLog` 由 backend 决定并收敛;`storage.checkpointer` 由 runner 策略自由选择**。backend 对 checkpointer 介质**永久无感**——连 resume 时也只是把原 spec 的 checkpointer 配置**原样转发**给新子进程,自己从不读其内容(见 [12-backend §resume](./12-backend.md))。

---

## 九、不做的事(范围边界)

- **不做事件 TTL / 清理** — 本期永久留存,清理策略留后续配置项。
- **不做分布式 / 多机** — 单 PG 实例。多机 fan-out 留后续。
- **不做事件重写 / 删除** — 严格 append-only,这是并发安全与审计可信的前提。
- **不取代 Checkpointer** — 两者职责正交,长期共存(见 §五)。
- **不内置鉴权** — 连接配置由 backend 经 AgentSpec 注入;runId/threadId 越权校验在 backend 投影端做。

---

## 十、生命周期审视:架构洁净度的判据

判断架构是否干净的有效方法:画出每层对象的**生命周期**,看上层生命周期短于下层时,上层销毁是否损坏下层。

```
SSE 连接      ├──┤                        秒级:随时断/重连/多开
backend 投影  ├────┤                      跟随连接,可随重启重建
backend 进程  ├──────────────────────┤    可重启
run 子进程    ├──────────────┤            分钟到小时级
EventLog/CP   ├──────────────────────────────►  永久
harness loop  (无独立生命周期:只产生事件,对以上全部无感知)
```

**核心判据:一切真相沉到生命周期最长的层(DB);短生命周期对象之间不直接耦合,只通过持久层派生/投影。** 逐对检查:

| 检查对 | 结论 | 依据 |
|---|---|---|
| 连接 < 投影 | ✅ | 连接断 → 只取消订阅;投影是无状态读游标,带 `Last-Event-ID` 重建 |
| 投影 < 执行 | ✅ | 仅经 EventLog 通信(铁律 3+4);**前提是子进程直写,不靠 backend 转发** |
| 执行 < backend 进程 | ✅(经下方建模修正) | 见 §10.1 存活判定 |
| 执行 < 数据 | ✅ | 子进程死,checkpointer/EventLog 仍在;resume 由新子进程重建 |
| harness 对全部上层 | ✅ | `agent.run()` 只 yield,对连接/投影/进程/介质零感知——**最干净的一层,必须守住** |

主干(执行/投影/数据三权分立、依赖指向抽象、harness 无感知)是干净的。两个脏点来自**实体粒度建模**,非分层错:

### 10.1 存活判定:单一真相源 `heartbeat_at`,废弃 `kill(pid,0)`

run 子进程比 backend 活得久(backend 重启子进程还在)。若让 backend 用 `kill(pid,0)` + 子进程读 heartbeat 表**互相探测存活**,就是两个不对称的真相源 = 脏。修正:

- 子进程定期 `UPDATE runs/attempt SET heartbeat_at = now()`(它本就连着 DB)。
- backend 重启后**只读 `heartbeat_at` 新鲜度**判活,**废弃 `kill(pid,0)`**——pid 跨重启不可靠(PID 复用),heartbeat 才是权威。
- 子进程**不判断 backend 死活**;孤儿回收交给独立超时(`cancelGraceMs×N` 无人 cancel 即自杀),与 backend 是否活着解耦。

> 收益:所有存活判定**降维到 DB 一列 `heartbeat_at`**(单一真相源),消除进程间互探。

#### 10.1.1 心跳消费时机:重启发现 + 运行期收割（reaper）

仅在 backend 重启时读一次 `heartbeat_at` 有个洞:**进程没死但任务卡死**(模型 fetch 永久挂起、工具不返回、死循环)既不触发 `child.on("exit")`、又(若心跳是独立定时器)照常打卡 → backend 永远以为它在干活,长任务的 [M10 单活跃 run 锁](./15-conversation.md#四防失控两道安全阀)永不释放。修正分两层,都不新增协议:

- **运行期收割(reaper)**:backend 把"读 `heartbeat_at` 判活"的逻辑从"仅重启触发"提升为**运行期周期扫描**(周期约 `heartbeatTimeoutMs/2`);`age > heartbeatTimeoutMs` → 标 `attempt.ended` + `run.status='interrupted'` + 发终态事件 + 触发 `onRunComplete`(联动释放 M10 会话锁)。落地见 [12-backend §运行期 Liveness Reaper](./12-backend.md#运行期-liveness-reaper主动收割卡死的-run)。
- **心跳 = 进度信号,而非存活信号**:`heartbeat_at` 的更新从独立 `setInterval` **移到 agent loop 每步推进**(每产出一个 `AgentEvent` / 每完成一次 `sink.append()` 打一次),**不保留兜底定时器**(无条件兜底会把 progress 退化成 liveness 假阳性)。这样 `heartbeat_at` 真正代表"任务在推进"(progress),而非"进程没死"(liveness);独立 `setInterval` 的假阳性(卡死但事件循环仍转)被消除。`stepStallTimeoutMs`(默认 300s)作为 backend reaper 判死的**二次校验窗口**(reaper 发现 heartbeat 过期后不立即判死,`kill(pid,0)` 探进程 + 等待 stepStallTimeoutMs 确认),**仅存 BackendConfig,不进 AgentSpec**(runner 子进程不感知它,卡死时天然不打心跳即被动配合)。

> 关键:动的仍是 `heartbeat_at` **同一列**,不加新字段/通道(奥卡姆:同一根管子换驱动源 + 把读取时机从"重启一次"扩到"运行期周期")。reaper 是 backend 侧**纯读 + 状态收敛**,绝不向 runner 发指令——单一真相源与"无进程间互探"两条原则继续成立。

### 10.2 实体拆分:`run`(逻辑) / `attempt`(物理执行)

一个逻辑 run 经历 interrupt→resume 会**跨越多个子进程**(原子进程死、resume 时起新子进程)。若把"逻辑 run"和"物理进程"混在一张 `runs` 表里,`pid` 列语义就漂移(只剩最后一个 pid,历史丢失,重启可能 attach 到已死旧 pid)。修正:拆两层实体。

| 实体 | 生命周期 | 字段 |
|---|---|---|
| **run**(逻辑) | 首次 start → 终态,跨多次 interrupt/resume | `run_id, thread_id, status, started_at` |
| **attempt**(物理执行) | 单个子进程的一次执行 | `attempt_id, run_id, pid, heartbeat_at, started_at, ended_at` |

- 一个 run 有 1..N 个 attempt;interrupt→resume = 起一个**新 attempt**(同 run_id)。
- backend 重新发现遍历 **attempt**(按 pid/heartbeat);前端订阅 **run**(按 run_id 聚合所有 attempt 的事件)。
- EventLog 的事件带 `run_id`(所有 attempt 共享),投影天然连续——**前端看到的是一条不断的流,哪怕中间换了子进程**。
- `pid` 永远属于某个不可变的 attempt(历史完整),`run` 是稳定的逻辑聚合。

> 两处修正方向一致:**把状态收敛到生命周期最长的层(DB),消除短生命周期对象(进程、连接)之间的直接耦合**——与 EventLog 拆分的原则同源。

---

**EventLog 文档结束。** 上游消费:[Backend](./12-backend.md)(投影端) / Runner 子进程(append 端)。职责对照见 [Checkpointer](./04-checkpointer.md)。