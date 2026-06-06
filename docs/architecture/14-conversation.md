# Conversation / Member — 多方会话与成员模型（agent team 的协作底座）

> Conversation 把 [Thread](./01-glossary.md)（一条 `{id, messages}` 对话线 = 隐式绑死一个 agent）**升维**为一个**汇总多个 agent thread 的容器 + 一份会话级 ledger（事实源）**；Member 把"谁在对话里"做成 first-class 名册（`AgentMember | HumanMember`）。这是把项目从 "agent runtime" 推进到 [vision §一](./00-vision.md) 的 "agent **team** runtime" 的抽象底座。
>
> 它解决的第一性问题：**一条会话里能挂多个成员（真人 + 多个 agent），它们彼此知道存在、能互相 @，真人在中间点名对话**——而**不**重写下层执行。每个 agent 仍持有一条完整的 [M9 thread](./11-backend.md#durable-runs)；Conversation 只在其**上方**加一层"会话级 ledger → 广播投影进各 thread"。
>
> 核心机制一句话：**广播可见 + @ 触发执行**。
>
> 关联：[00-vision](./00-vision.md)（Member/Conversation 抽象出处） · [11-backend](./11-backend.md)（容器落地层） · [13-event-log](./13-event-log.md)（执行事实源，本层不触碰） · [12-agent-spec](./12-agent-spec.md)（run 注入契约）。
>
> 实现里程碑见 [M10 spec](../superpowers/specs/2026-06-06-m10-member-conversation.md)。本文沉淀的是**持久架构**（模型与不变量），spec 是**某一期的落地切片**。

---

## 一、为什么需要 Conversation 这一层

从第一性事实推导，M9 及之前的 `thread` 模型撑不起 team 协作：

1. **thread 隐式绑死单个 agent** — `(messages)` 里只有 "user ↔ 一个 assistant" 两方。多 agent 无处安放。
2. **多 agent 要彼此"知道存在"** — agent X 想 @Y 协作，前提是它的上下文里出现过 "Y 在场"。thread 没有成员名册概念。
3. **真人是 team 的 first-class member，不是"用工具的人"** — vision 要求真人与 agent 同为成员。thread 的 "user" 角色把真人降格成了一个 message role。
4. **"看得见"与"要回应"必须解耦** — team 里 A 对 B 说话，C 看得见但不必插话。thread 只有"在不在 messages 里"一个维度，无法表达"可见但不触发"。
5. **执行层（M9）不该为协作语义买单** — run/attempt、EventLog、SSE 投影、cancel/resume 是稳定的执行底座。协作是上层语义，必须**叠加**而非**侵入**。

> **关键判断**：Conversation **不是替换 thread**，而是 thread 的**汇总容器**。每个 agent 仍跑一条 M9 thread；Conversation 只多了"成员名册 + 会话 ledger + 广播投影"。`(conversationId, agentMemberId)` 唯一定位一条 M9 thread。**单 agent 会话精确退化为一条 M9 thread**——这是零退化的根。

---

## 二、核心抽象

| 抽象 | 含义 | 与既有模型的关系 |
|---|---|---|
| **Conversation** | 汇总多个 agent thread 的容器 + 会话级 ledger（事实源）。有自己的 `id`（汇总维度） | 取代"一人对一 agent"的单 thread 模型；单 agent 会话退化成 M9 thread |
| **Member** | team 的 first-class 成员名册项：`AgentMember`（指向 agentStore 的 agentId）或 `HumanMember`（外部 userRef） | vision §三 的 `type Member = AgentMember \| HumanMember` |
| **Ledger（conversation ledger）** | 会话事件的唯一事实源：消息 + 成员系统事件，统一形状、单调 seq | 与 [EventLog](./13-event-log.md) 同精神（只追加、可投影），但维度不同：ledger 是**会话语义层**，event_log 是**run 执行层** |
| **thread.messages** | 每个 agent 的执行态消息序列 | **从 ledger 广播投影派生**的物化态，不是事实源（沿用 M9 "messages 是派生态" 的纪律） |
| **addressedTo** | 一条消息的"点名集" | **同时编码可见性与执行性**（见 §三） |
| **triggerMode** | 触发策略开关：`mention`（被 @ 才动）/ `all`（任何新消息都触发，留口子） | 当前只实现 `mention`；`all` 是 autonomous 协作（后续里程碑） |

### Member 的判别联合

```ts
type AgentMember = { kind: "agent"; memberId: string; agentId: string; displayName?: string };
type HumanMember = { kind: "human"; memberId: string; userRef: string; displayName?: string };
type Member = AgentMember | HumanMember;   // discriminatedUnion("kind")
```

- `AgentMember.agentId` 指向 backend agentStore——一个 agent 实体可被多个会话复用。
- `HumanMember.userRef` 是外部用户引用，不接 SSO/IdP（身份系统是更上层 surface 的事）。
- 真人、agent、系统三类发言**走同一条 ledger → 广播 →（可选）触发链路**，无特例分支。

---

## 三、核心机制：广播可见 + @ 触发执行

一条消息（无论真人发还是 agent 发）的完整生命周期：

```
任何 member 发一条消息 { sender, addressedTo[], content }
        │
        ▼
  ① append 到 conversation ledger（事实源，带 sender / addressedTo / ts / seq）
        │
        ▼  广播投影（visibility = 全员）
  ② 对每个在场 agent member M：把这条消息投影进 M 的 thread.messages
        - 别人（真人/别的 agent）说的 → role=user，content 前缀署名 "[<senderName>]: ..."
        - M 自己说的                → role=assistant（它自己的输出）
        ▼  @ 触发判定（execution = 仅 addressedTo）
  ③ for each agentMember M in addressedTo：
        triggerMode 允许（mention：总是；all：留口子）→ fork M 的 run（M9 路径）
        子进程 agent.run() 此时 thread 里已含 ② 投影的全部累积消息
     未被 addressedTo 点名的 agent：② 已让它"看见"，③ 不起 loop
        ▼  循环硬阀（execution 受 hop 计数约束，见 §四）
  ④ 触发前检查 hopCount，超限拒触发并广播系统消息
```

> **这一刀的本质**：`addressedTo` 一个字段**同时编码两个正交维度**——
> - **可见性**（②）：对所有在场 agent **广播**，谁都看得见；
> - **执行性**（③）：**仅触发** addressedTo 里点名的 agent 起 loop。
>
> "user 对 X 说话，Y 看得见但不回应" = ② 让 Y 的 thread 攒下这条消息，③ 因 Y 不在 addressedTo 里而不起 loop。**"不回应" 是机制保证，不是 prompt 工程**——不靠模型自觉"我不该插话"，而是没被 @ 的 agent 根本不起 run。

### 三方同构

```
真人 H 发言        = ledger 消息 { sender: H, addressedTo: [X] }
                     → ② 广播给 X/Y 的 thread → ③ 触发 X 起 loop
agent X 输出里 @Y  = X 的 assistant 消息 { sender: X, addressedTo: [Y] }
                     → ② 广播给 X/Y 的 thread → ③ 触发 Y 起 loop（mention）
成员变化           = ledger 系统事件 { sender: __system__, kind: 'member.joined', memberId: Y }
                     → ② 广播投影成 system/user 消息注入所有在场 agent thread
                        （"成员变化：Y 加入。当前在场：H, X, Y"）
```

成员 join/leave 同样是 ledger 里的一条记录，广播注入各 thread——下次任一 agent 起 loop 时，它已"知道"谁在场，可以 @。

---

## 四、防失控：两道安全阀

多 agent 能互相 @，天然带来"X@Y→Y@X→…"无限循环的风险。本层用**两道纯机械安全阀**封死，**不依赖语义级"任务是否完成"的判断**：

| 安全阀 | 挡什么 | 机制 |
|---|---|---|
| **同 conversation 单活跃 run** | **并发**爆炸 | 一个会话同时只跑一个 run（超限 409）。X@Y 触发 Y，Y 跑完才轮到下一个；多 agent 永远串行，不会指数级 fan-out |
| **`maxConsecutiveAgentHops`（默认 8）** | **有限串行**来回 | 机械计数：真人/外部消息触发 → 重置 hopCount=0（真人是闸门）；agent 触发 agent → hopCount++；超限 → 拒绝触发 + 广播 "连续 agent→agent 触发达上限，已暂停，等待真人介入" |

> **设计立场**：这两道阀是**机械的**（数 run、数 hop），**不判语义**。语义级的协作终止判定（模型自判"任务完成可以停了"）属于更后期的 autonomous 协作能力，与本层正交。本层只保证：**没有外部（真人）持续推动，agent 群必然在有限步内停下**。

真人在 `mention` 模式下是**天然闸门**——只有被 @ 才动；要让对话继续，必须有真人或被触发的 agent 显式 @ 下一个。两道阀 + 真人闸门共同把"看得见的多 agent 会话"约束成一个**可终止、不爆炸**的系统。

---

## 五、Ledger vs thread.messages —— 事实源与派生态

这是本层最关键的建模纪律，直接继承 [EventLog 的"一切真相沉到生命周期最长的层"](./13-event-log.md#二解耦铁律)：

| | conversation ledger | thread.messages |
|---|---|---|
| **定位** | 会话事件**唯一事实源** | 每个 agent 的执行态**派生物化** |
| **写入** | 真人消息、agent 输出、成员事件统一 append | 由 ledger **广播投影**写入（经 checkpointer） |
| **形状** | `{ seq, sender, addressedTo, kind, content, ts }` 统一 | M9 `Message[]`（role + content） |
| **服务对象** | 会话级回放 / 审计 / SSE 汇总投影 | agent.run 从 checkpointer 恢复执行 |
| **可重建性** | 不可重建（是源） | 可从 ledger 重新投影得到 |

> **为什么物化进 thread.messages，而不是每次 run 现读 ledger 重算？**
> M9 的 `agent.run()` 从 **checkpointer** 恢复 messages。把 ledger 消息物化进各 agent 的 thread.messages（经 checkpointer.save），让 **M9 恢复路径零改动**——agent 子进程仍只认 checkpointer，完全不知道上层有 ledger。这是"叠加而非侵入"原则的具体落点：协作语义停在 backend 层，**绝不下沉到 framework/harness/runner**。

### 与 EventLog 的关系（两条不同维度的"日志"）

| | conversation ledger | [event_log](./13-event-log.md) |
|---|---|---|
| **维度** | 会话语义层（谁对谁说了什么、谁进谁出） | run 执行层（一次 agent loop 产生的 AgentEvent 流） |
| **粒度** | 一条 ledger entry = 一条会话消息/成员事件 | 一条 event_log record = 一个执行事件 |
| **关系** | 一条 ledger 消息若 @ 了 agent → 触发一次 run → 该 run 产生多条 event_log 记录 | 反向：event_log 的 run 归属某 (conversationId, agentMemberId) thread |

会话级 SSE 投影（`GET /conversations/:id/events`）把**两者按 ts 归并成一条流**：真人/系统的 ledger 事件 + 各 agent run 的 event_log 事件，用合成 cursor（`${source}:${rawSeq}`）做 `Last-Event-ID`，前端订阅一条流即见全貌。两个源各有独立 AUTOINCREMENT，无法共用统一 seq；ts 归并 + 合成 cursor 解决排序与断点续传。

---

## 六、退化等价（零退化的根）

```
conversation 只挂 [H（真人）, X（一个 agent）]，真人始终 @X：
  POST /conversations/:id/messages {H, @X}  ⟺  M9 的 POST /threads/X/runs
  GET  /conversations/:id/events            ⟺  M9 GET /runs/:id/events
  X 的 thread / checkpointer / resume / cancel 全是 M9 原物
  → M1–M9 的执行、持久化、恢复路径一行不改
```

单 agent 会话 = 一条 thread + 一条 "X joined" 系统消息，行为完全退化成 M9。**Conversation 层是 strict superset**：它能表达的最简形态就是旧的单 thread 模型。

---

## 七、不变量（invariant）

- **Conversation 是 thread 汇总容器，绝不破坏退化形态** — "1 human + 1 agent" 会话 = 旧 thread。
- **执行层（M9）零侵入** — EventLog 四铁律 / run-attempt / SSE 投影 / cancel / resume / heartbeat / checkpointer / event_log schema 一行不改。
- **可见性广播 + 执行靠 @** — ② 对所有在场 agent 广播，③ 仅触发 addressedTo；不回应靠机制不靠 prompt。
- **ledger 是会话事件唯一事实源** — thread.messages 是广播派生态（物化进 checkpointer）。
- **真人 / agent / 系统发言同构** — 同一条 ledger 记录走同一链路，无特例分支。
- **同 conversation 单活跃 run + `maxConsecutiveAgentHops`** — 两道机械安全阀，保证可终止不爆炸。
- **协作语义停在 backend 层** — 绝不下沉到 framework/harness/runner；agent 子进程只认 checkpointer，不认识 ledger/conversation。
- **机械防失控，不做语义终止判定** — 数 run、数 hop；语义级 autonomous 终止留后续。

---

## 八、Surfaces —— 这套逻辑在用户接触面的形态

Conversation/Member 是 **L5 backend** 的语义模型；它向上通过 HTTP/SSE 暴露，[L6 Surfaces](./00-vision.md#四当前分层架构) 决定**长什么样**。同一套 backend 模型可映射到截然不同的接触面，**backend 不感知自己被装在哪种 surface 里**：

| Surface 形态 | 映射方式 | 说明 |
|---|---|---|
| **Web UI（自建 SPA）** | 一个会话 = 一个聊天窗口；成员名册 = 侧边栏头像列表；@ = 输入框 mention 控件；`GET /conversations/:id/events` = 实时消息流 | 最直接的映射，全字段可控 |
| **现成 IM 软件（飞书 / Slack 等）** | IM 群 ↔ conversation；群成员 ↔ Member（真人 = IM 用户，agent = bot）；IM 的 `@bot` ↔ `addressedTo`；IM webhook → backend `POST /messages`；backend SSE → IM 消息回推 | **复用 IM 现成的"群 + @ + 成员"语义**——这正是本模型与 IM 天然同构的原因：IM 早已是"多成员 + 广播可见 + @ 点名"的系统 |
| **CLI** | 交互式 REPL：`@<memberId> <text>` 发消息触发 / 不带 @ 仅累积 | 调试与脚本化入口 |

> **关键洞察**：本层"广播可见 + @ 触发"的机制，与主流 IM（群聊 + @ 提醒 + 成员进出系统消息）是**结构同构**的。这不是巧合——团队协作的交互范式本就收敛到了"群 + 成员 + 点名"。因此把 agent team 接到现成 IM 上，几乎是字段直映：IM 群即 conversation，群里的人和 bot 即 Member，@bot 即 addressedTo 触发，成员进出即 member.joined/left 系统消息。一个 IM bot adapter（webhook ↔ backend HTTP）即可让整个 agent team 在飞书/Slack 里运转，无需自建前端。

**分层规则不变**：surface 只吃 backend 的 HTTP/SSE，不直接碰 L4 以下；backend 不接 IM 业务逻辑（那是 surface 层 adapter 的事）。换 surface = 换一个 L6 adapter，conversation 模型零改动。

---

## 九、演进位置

| 能力 | 本层 | 后续 |
|---|---|---|
| 多 agent 同会话、互相 @ | ✅ `mention` + 广播可见 | — |
| 真人作为 first-class member | ✅ `HumanMember` | 身份系统 / SSO（surface + 更上层） |
| agent 作为另一 agent 的 tool | — | agent-as-tool（与本层正交，见 [vision §五](./00-vision.md#五milestone-路线)） |
| autonomous 多方协作（`triggerMode=all`、语义终止判定） | schema 留口子，不实现 | 后续 milestone |
| TeamSpec / 角色 / 协作策略 | — | 成员名册升级为有策略的 team 配置 |
| Task（长任务派发/验收） | — | 与 Conversation 正交的另一种 first-class 运行形态（[vision §八](./00-vision.md#八未明确的概念task长任务运行形态)） |

> **立场**：本层只交付"多成员 + 广播可见 + @ 触发执行 + 两道机械安全阀"这一最小可用协作底座。autonomous（无真人推动也能协作到终）、TeamSpec、Task 都在其上叠加，**不在本层做决定，但本层的 ledger / Member / triggerMode 为它们留了口子**。