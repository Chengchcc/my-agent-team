# 运行契约归 ACP，surface 契约归 AHP

> 状态：**Accepted**（2026-09-29。目标架构见「模块分工」；删除清单是验收条件；规范模型与账本编码对齐见决策三。）

## 背景

今天有两条自研方言。

运行轴上，`adapter-oma-agent`、`adapter-claude-agent`、`adapter-pi-agent`、`adapter-omp-agent` 各自用那个 CLI 自己的方言说话（oma 是 JSONL RPC，claude 是 stream-json，pi 与 omp 各自的 json），每个都在自己的方言里把同一批活重做一遍：事件映射、审批上浮、工具挂载、会话引用。ACP 轨已经在旁边建起来并验收过（`adapter-acp`、oma 的 ACP 面、审批与恢复与 steering 与 mcp-over-acp，见 [ADR 0039](./0039-approval-request-is-a-product-contract.md)），但两套并存没有期限。

surface 轴上，Web 与 Lark 走 HTTP/SSE，事件词汇是我们自研的。实测规模：契约类型 422 行（`packages/api-contract`）、核心事件 14 类、5 个 SSE 端点（`agent-run/http.ts:393`、`agent/http.ts:645`、`conversation/http.ts:1729`、`workflow/http.ts:2786` 与 `:2919`）、Web 侧 `EventSource` 管道 26 行、Lark 侧 2 处引用。

两条方言并存而删除没有期限，账就是净增。**接标准轨时必须同时写下它删掉什么、什么时候删，删不掉的部分就是负债。**

AHP（Agent Host Protocol）是同一道边界上的标准方言：微软维护，仓库 2026-03-12 建，半年 27 个发布，当前规范 0.9.0（2026-08-28）。它按频道给出会话状态与动作流，客户端用与上游同源的纯 reducer 推出状态；重连是 `serverSeq` 回放加快照回退加 `missing` 清单。上游把 reducer、可派发判定表（99 条）、五份 JSON Schema、283 条 reducer 向量与 57 条 round-trip 向量都作为公共 API 发布，但**只发布客户端 SDK，没有服务端 SDK**，VS Code 那份是参考实现。频道稳定性索引：root、session、chat、terminal、telemetry、resource-watch 为 2（Stable），changeset 为 1.2，annotations 为 1.1，automation 目录与 automation run 为 1.0，MCP 频道为 1.2。

### 粒度不对齐已经在漏事实

账本今天以「消息」为粒度：一条 canonical 消息一行，身份是 `(agent_run_id, message_index)`，内容是一份 `MessageRevision`（`blocks`、`tools` 内嵌）；没有轮次实体，工具调用不是一等对象，人工输入在 `pending_action` 且**解决结果不写回账本**。ACP 与 AHP 都是「轮次实体加类型化片段加一等工具对象」：

| | 账本 | ACP | AHP |
|---|---|---|---|
| 轮次 | 无实体，读时推断 | 一次 `session/prompt` 一轮 | `Turn` 实体，带 turnId、状态、usage |
| 内容片段 | `blocks` 贴在某条消息上 | update 流里的事件 | `ActiveTurn.responseParts` |
| 工具调用 | 消息载荷，无 status、无关联键 | 一等对象：`toolCallId`、status、kind、rawInput/rawOutput | 一等对象：`toolCallId`、status、title、intention |
| 人工输入 | 另一张表，解决后不留痕 | `request_permission` 一次往返 | 输入请求是片段，解决后落 `InputRequestResponsePart` |
| 顺序 | 对话内 `seq` | 子进程内部 | channel 内 `serverSeq` |

后果是实证的：ACP 轨的 `buildOutcomeMessages` 只产出 assistant 文本，于是四次 `todo_write` 在账本里一行都没留下（`product_tool_call` 有记录、日志有 `tool_end error=false`，账本零行），而 [conversation/history](../architecture/conversation/history.md) 声明工具消息应进 History。

（2026-09-29 S0 首刀已修：映射改为按到达顺序记产出片段，同一次 run 的四次工具调用现在提交九行账本，向量见 `packages/adapter-acp/src/event-mapping.test.ts` 的「durable tool facts」。）

## 决策

1. **目标态：运行契约归 ACP，surface 契约归 AHP；两条自研方言下线。** 运行轴只留 `adapter-acp`（其余 agent 经官方桥或原生 `--acp` 接入）；surface 轴只留 AHP，外加快照型 REST 承担 CRUD 与列表（agents、projects、skills、workflows、settings），AHP 不管这些。**每一个 surface 都走 AHP 客户端，包括 Web、Lark bot 与第三方 UI（VS Code、ahpx），不设「内部 feed」这类例外通道**：例外通道会让 surface 轴重新长出一条自研线，而本次的目的正是让它只剩一条。Lark 是 Bun 进程，官方客户端的 WebSocket 传输在 Node 21+ 与 Bun 下可用；鉴权沿用既有的「upgrade 时完成」模式。oma 自己的 RPC 模式保留为本地 CLI 与 TUI 的通道，它不对外。**删除清单见专节，且是每个相位的验收条件。**

2. **AHP 的位置、范围与维护契约。**

   - 位置：surface 层的契约，与现有 REST 并列，不新增层。它相对 ACP 正交：ACP 在 Adapter 与 Runtime 那条纵轴，AHP 在 Surfaces 那条横轴。
   - 范围：只做稳定性索引 ≥ 2 的频道，即 root、session、chat，terminal 随后。changeset、annotations、automation、MCP 频道不进这一轮。
   - 钉 0.9.x。升级是有意识动作：先跑自建互操作用例（我们的 server 对上游 TS 客户端），再看升级内容。
   - 服务端我们自己写（上游没有），复用其 reducer、可派发判定、JSON Schema 与一致性向量；能力一律先声明后使用，版本号不用于能力探测。

3. **规范模型与账本编码对齐（S0，AHP 面的前置）。** 定义唯一规范模型 `session` / `chat` / `turn` / `part` / `toolCall` / `inputRequest`，账本按它编码。字段名在概念相同时采用两协议既有的词（`toolCallId`、`turnId`、`status`、`inputRequest` 等），不做与模型无关的机械改名。五处调整：

   - 补轮次实体：一次 Run 的一次输出就是一个 turn，提交时落显式字段，不留给读者推断；
   - 工具调用升为一等字段：`toolCallId`、`toolName`、`status`、`rawInput`、`rawOutput`，可仍挂在消息行上，但必须有 id 关联；
   - 人工输入的解决结果作为片段写回账本（AHP 的 `InputRequestResponsePart` 就是这个位置）；
   - 会话层级定为 session = agent 加工作区（project / worktree），chat = conversation，不需要新表；
   - 坐标权威定为对话内 `seq`，AHP 的 `serverSeq` 由它派生并加回放缓冲，子进程内部顺序不外泄。

   判据：两条协议的绑定退化成字段重命名级，映射里不出现推断或聚合；用一致性向量钉住（固定 facts 产出固定的 turn、part、toolCall、inputRequest 结构）。历史行不重写，读取侧容忍旧行。

4. **权威关系不变。** 账本加 Run 状态是唯一权威；AHP 面只有两条边——只读投影、命令进控制面，禁止直写账本；终态提交是唯一写路径。这与 [system-overview](../architecture/system-overview.md) 的不变量 3、4、5 一致，Run 仍是唯一执行身份。

5. **替换而非并列。** 未完成替换前，不新增依赖旧方言的功能；每条标准轨的删除项与期限写在本 ADR 的删除清单里。

## 模块分工（图解）

目标架构：

```mermaid
flowchart TB
  subgraph SURF["端"]
    WEB["Web · Next.js<br/>AHP 客户端 + reducer 派生状态"]
    VS["VS Code Agent Sessions / ahpx"]
    LARK["Lark bot · AHP 客户端"]
  end

  subgraph WIRE["标准面"]
    AHPW["AHP over WebSocket<br/>root · session · chat"]
    RESTW["REST · 只做 CRUD 与列表"]
  end

  subgraph BE["Product Backend · 唯一事实源"]
    AHPS["AHP 面<br/>命令与订阅路由 · serverSeq · 回放缓冲 · 快照回退"]
    CAN["规范模型层<br/>session · chat · turn · part · toolCall · inputRequest"]
    CONV["conversation<br/>账本 · 只追加 · seq 即顺序"]
    RUN["agent-run 控制面<br/>入队 · 派单 · 终态提交 · 审批与 ask · 恢复"]
    WF["Workflow 引擎"]
    PT["product-tools 分派内核"]
    DB[("SQLite")]
  end

  subgraph AD["Adapter 层 · 收敛后"]
    AAC["adapter-acp · 唯一运行适配器<br/>含 mcp/message 中继"]
  end

  subgraph RT["Runtime 层"]
    OACP["oma · --mode acp"]
    OMP["omp acp"]
    CCB["claude-agent-acp 官方桥"]
    PIB["pi-acp 桥"]
  end

  WEB --> AHPW
  WEB --> RESTW
  VS --> AHPW
  LARK --> AHPW
  AHPW <-->|订阅快照与动作 · 客户端命令| AHPS
  AHPS -->|命令走控制面| RUN
  AHPS -->|只读| CAN
  CAN --> CONV
  RUN -->|终态提交 · 唯一写路径| CONV
  RUN --> WF
  RUN -->|派单 spawn| AAC
  AAC --> OACP
  AAC --> OMP
  AAC --> CCB
  AAC --> PIB
  PT -->|mcp/message 就地应答| AAC
  CONV --> DB
  RUN --> DB
```

粒度对齐前后的差别：

```mermaid
flowchart LR
  subgraph T["今天 · 两处推断"]
    E1["子进程<br/>轮次 · 工具对象 · 权限往返"]
    L1["账本<br/>消息行 + 载荷内嵌工具事实<br/>人工输入在另一张表"]
    S1["各端<br/>从消息推断轮次与状态"]
    E1 -->|"各 adapter 各自映射<br/>ACP 轨只留文本"| L1
    L1 -->|"每端各写一套推断"| S1
  end

  subgraph G["目标 · 一份归约，两端直读"]
    E2["子进程<br/>轮次 · 工具对象 · 权限往返"]
    C2["规范模型<br/>turn · part · toolCall · inputRequest"]
    L2["账本<br/>按规范模型编码"]
    P2["AHP 面<br/>字段级绑定"]
    S2["各端<br/>上游同源 reducer"]
    E2 -->|"一份归约契约"| C2
    C2 --> L2
    L2 --> P2
    P2 -->|"快照与动作流"| S2
  end
```

## 删除清单（验收条件）

| 轴 | 删除项 | 何时 |
|---|---|---|
| 运行 | `packages/adapter-oma-agent`、`adapter-claude-agent`、`adapter-pi-agent`、`adapter-omp-agent`，以及 `BackendKind` 里的 `oma` / `claude_code` / `pi` / `omp` | 该家经 ACP 通过 conformance 与隔离验收之后，逐家下线 |
| surface | 自研核心事件词汇（14 类）与 5 个 SSE 端点（`agent-run`、`agent`、`conversation`、`workflow` 两处） | Web 切到 AHP 客户端之后 |
| surface | Web 侧 `EventSource` 管道 | 同上 |
| surface | Lark 的 HTTP 事件消费与自研事件解析 | 改为 AHP 客户端订阅（与 Web 同时切换） |

## 相位

| 相位 | 内容 | 验收 |
|---|---|---|
| S0 | 规范模型与账本编码对齐（决策三），含修 ACP 轨工具事实漏账 | 一致性向量；ACP 轨 N 次工具调用留 N 组工具事实 |
| S1 | AHP 最小面：root / session / chat，`initialize` / `subscribe` / `dispatchAction` / `reconnect` | 上游 TS 客户端互操作用例；官方语料 |
| S2 | Web 切到 AHP 客户端，状态由上游同源 reducer 派生；REST 不变 | Web 测试全绿且不再消费自研事件 |
| S3 | 删事件词汇与 SSE；Lark 切到 AHP 客户端 | 删除清单逐条勾掉 |
| R1 | cc 经官方桥、pi 经 `pi-acp` 接入 ACP | conformance 先行，再隔离验收 |
| R2 | Workflow 的 agent 节点支持 `acp` kind | 节点级端到端 |
| R3 | 逐个下线原生 adapter 与旧 kind | 删除清单逐条勾掉 |

R1 至 R3 承接 [ADR 0039](./0039-approval-request-is-a-product-contract.md) 的 P3 至 P5，本例只是把两条轴的删除并到同一份验收里。

## 后果

收益：第三方客户端可以直接连（VS Code 的会话面板、ahpx），多客户端同步与重连语义不必自造；运行轴的方言从五套收敛到一套；surface 轴从自研词汇收敛到标准词汇；补齐投影层之后，前端状态变成可测试的纯函数。

代价：AHP 服务端要我们自建；上游处在 0.x，升级要跟；迁移期两条线并存，直到 S3 才回到一条。

风险与对策：接一半就成净负债，所以删除项写进验收；账本权威被绕过，所以 AHP 面只保留两条边；上游发破坏性小版本，所以钉版本加互操作用例当闸门；历史行重写风险高，所以只对新写入生效。

## 关联

- [ADR 0039 审批请求是产品的一等契约](./0039-approval-request-is-a-product-contract.md)：运行轴（ACP）的目标与相位。
- [ADR 0038 HITL 与重启恢复](./0038-hitl-run-resume-after-restart.md)：审批与问答作为产品契约。
- [系统总览](../architecture/system-overview.md)：唯一执行链与不变量。
- [Conversation History](../architecture/conversation/history.md)：账本的现状与已知缺口。
- [Run 输出与实时更新](../architecture/runs/output-and-live-updates.md)：运行侧事件的现状。
