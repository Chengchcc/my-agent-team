# 项目愿景与架构总览

> 这是 my-agent-team 的入口文档。先讲我们要做成什么（愿景），再讲为此分了几层（架构），最后给出 milestone 路线和文档导航。

---

## 一、项目愿景

**my-agent-team 是一个 agent team 的管理与协作运行时**。

在这个系统里：

- **真人和 agent 都是 team 的成员**（first-class member），不是"人用工具"或"agent 帮人"的从属关系
- 系统支持三类交互全等价：
  - 真人 ↔ agent（IM bot、web chat）
  - agent ↔ agent（agent 调用 agent、多 agent 协作完成任务）
  - 真人 ↔ 真人（系统不阻碍，但不是核心价值）
- 每个 agent 拥有独立的 workspace（记忆、技能、人格），可以被多个 thread 复用

最终形态：用户在一个统一的协作空间里，**像组建并管理一个真实团队那样**装配自己的 agent team，按需邀请真人或 agent 进入对话。

---

## 二、长期目标拆解

为支撑上述愿景，系统必须分阶段建立五组能力：

| 能力组 | 当前覆盖 | 引入时机 |
|---|---|---|
| **单个 agent 能跑起来** | L1–L4 已完成 | M1–M6 |
| **多 agent 托管为服务** | L5 Backend 进行中 | M7–M8 |
| **真人作为成员加入对话** | L6 Surfaces 待建（frontend + IM bot + CLI） | M9 起 |
| **多方协作（agent↔agent / 多人多 agent 同会话）** | Member / Conversation 抽象待建 | M10 起 |
| **长任务（task）的派发、执行、验收** | Task 抽象与质量评估体系待建 | 未明确（见下文第八节） |

---

## 三、核心抽象（演进中）

当前栈以 **agent** 为中心。随着 vision 落地，会引入两类新抽象：成员/会话维度的（Member / Conversation / TeamSpec）和工作维度的（Task）。

| 抽象 | 含义 | 引入 milestone | 现状 |
|---|---|---|---|
| **Agent** | 一个有 workspace、有 model、能 run 的实体 | M3 已就位 | `createAgent()` / `createGenericAgent()` |
| **AgentSpec** | "如何启动一个 agent run" 的 wire 契约 | M7 已就位 | `@my-agent-team/agent-spec` |
| **Member** | 团队中的一员，可能是 Agent 也可能是 Human | M10 | 计划：`type Member = AgentMember \| HumanMember` |
| **Conversation** | 多方参与的会话（取代单一 threadId 的"一人对一 agent"模型） | M10 | 计划：conversation 内挂多个 Member；适合短时同步交互 |
| **Task** | 长时异步工作单元（小时级甚至跨天），有显式的发布/执行/验收流程和完成质量评估 | 未明确 | 见第八节；与 Conversation 正交，是另一种 first-class 运行形态 |
| **TeamSpec** | 一个 team 的配置（成员列表、协作策略） | M11+ | 计划：与 AgentSpec 同层但独立 schema |

**关键判断**：

- AgentSpec 不会被替换。它是"启动一次 agent 运行"的契约，永远成立
- TeamSpec 是更高一层的"配置一个团队"的契约，与 AgentSpec 并存
- Conversation 与 Task 是两种正交的协作形态——前者是"开会"，后者是"工单"。同一个 team 同时支撑两者

---

## 四、当前分层架构

```text
L6 Surfaces    用户/IM 接入面：frontend web、IM bot（飞书/Slack）、CLI
                ↓ 通过 HTTP/SSE / IM webhook 调用
L5 Backend     常驻服务：多 agent 托管 + 鉴权 + 多租户 + 持久化（M8）
                ↓ 通过 in-proc 或 runner 子进程装配
L4 Harness     有观点的产品层：内置 tools + system prompt + 权限策略
                ↓
L3 Framework   装配层：createAgent 式 API，组合 model + tools + plugins
                ↓
L2 Runtime     运行内核：messages → model → tools → messages
                ↓
L1 Protocols   类型契约：Message / ChatModel / Tool
```

**层级特性**：

| 层 | 是库还是进程 | 谁是消费者 |
|---|---|---|
| L1–L4 | 都是库 | 上层装配 |
| L5 Backend | 进程（HTTP server） | L6 Surfaces |
| L6 Surfaces | 进程（web app / bot / CLI） | 最终用户 |

**分层规则**：依赖只能向下；L6 不直接吃 L4 以下；harness 永远不知道自己被装在哪种 surface 里。

---

## 五、Milestone 路线

| Milestone | 交付 | 状态 |
|---|---|---|
| M1 | `@my-agent-team/core`（L1+L2）+ `@my-agent-team/test-helpers` | ✅ |
| M2 | `@my-agent-team/adapter-anthropic` + `@my-agent-team/tools-common` + `@my-agent-team/cli` | ✅ |
| M3 | `@my-agent-team/framework`（L3 骨架） | ✅ |
| M4 | framework 补齐（resume / Interrupt / ContextManager / Logger / Checkpointer 6 法） | ✅ |
| M5 | plugin-fs-memory + plugin-progressive-skill + framework `Plugin.tools` | ✅ |
| M6 | `@my-agent-team/harness` + tools-common 4 tool + cli `--workspace` | ✅ |
| M7 | `@my-agent-team/agent-spec` + `@my-agent-team/runner-stdio` + framework `AgentEvent.error` | ✅ |
| **M8** | **`apps/backend` MVP + `@my-agent-team/checkpointer-sqlite`：HTTP server + SQLite + agent CRUD + run SSE + runner pool（in-proc）** | ✅ |
| M8.5 | `@my-agent-team/plugin-permission` | 待定 |
| **M9** | **Durable Runs：run 子进程执行 + [EventLog](./14-event-log.md) 事实源(直连 PG) + SSE 投影解耦(Last-Event-ID 续读) + cancel 透传 + backend 重启重新发现 + 迁移台账统一 + M1/M3 债务** | 🚧 |
| **M9.x** | **Checkpointer HTTP/RPC 子服务化**（sandbox 落地的前置；详见 [04-checkpointer §已知限制](./04-checkpointer.md#已知限制sandbox-隔离)） | 待定 |
| M10 | **Member / Conversation 抽象**（thread → conversation；引入 `HumanMember`） | 待定 |
| M11 | agent-as-tool（一个 agent 可作为另一个 agent 的 tool） | 待定 |
| M12 | 多方 conversation（>2 个 member 同时在场） | 待定 |
| **M13** | **`apps/web` frontend（独立 SPA，调 backend HTTP/SSE）** | 待定 |
| M14 | IM bot adapters（飞书 / Slack webhook → backend） | 待定 |
| M15+ | TeamSpec / team governance / sandbox runner / 跨语言 runner | 待定 |

**里程碑分工**：

- **harness/framework 继续迭代**：M8.5（permission）/ M9（runner 协议）/ M10（Conversation 抽象渗透到 framework）/ M11（agent-as-tool）
- **backend 继续迭代**：M8（MVP）/ M8.5（接 permission）/ M10（conversation 接口）/ M12（多方协议）
- **新建 surface 层**：M13（web）/ M14（IM bot）

---

## 六、设计原则

1. **No protocol without proven need** — 协议字段只为已发生的痛点加，不为想象需求加
2. **No deep imports** — 跨包只能从 index.ts 进
3. **Composition over hooks** — 能用 JS 函数嵌套解决的，不加框架钩子
4. **State belongs to caller by default** — messages 由调用方持有，runtime 原地推进
5. **Layer downward dependency** — L6→L5→L4→L3→L2→L1，反向 = bug
6. **AsyncIterable is the event stream** — 不重新发明 EventBus / Observer
7. **One concept, one name** — 同一事物全项目同一称呼
8. **Rule of three** — 第三次重复出现才提取抽象

---

## 七、Runtime 契约（保留）

`run(model, tools, messages, options)` 是一个 async generator。流式 yield assistant 快照，把完成的 assistant 消息和 tool 结果推进调用方持有的 `messages` 数组，串行执行 tool，无 tool_use 或达 maxSteps 时停止。

Model 抛错向上传播。Tool 抛错转成 `is_error: true` 的 `tool_result`，让 LLM 能从错误上下文继续。

---

## 八、未明确的概念：Task（长任务运行形态）

当前 runtime/agent loop 服务的是 **Conversation 形态**——典型 agent loop 几秒到几分钟，模型 stop 即认为完成。

但 my-agent-team 的目标场景里还有**另一类等价重要的形态**：**Task（长任务）**——以小时级甚至跨天为单位的工作单元，发布人 ≠ 执行人是常态，完成不能只看"模型不再调 tool"，需要外部验收。

### Conversation vs Task（已识别的差异）

| 维度 | Conversation | Task |
|---|---|---|
| 时长 | 秒~分钟级 | 小时~天级 |
| 触发 | 一句话输入 → 流式回复 | 显式"派活"动作 |
| 完成判定 | 模型 stop（no tool_use / maxSteps） | **需要独立的完成质量评估体系** |
| 流程 | run → done | **发布 → 执行 → 验收**（可能多轮返工） |
| 状态载体 | thread / messages | task lifecycle + 产物 + 验收记录 |
| 参与方关系 | 实时同步对话 | 异步交付，发布人 ≠ 执行人 |
| 与现有抽象关系 | 对应 thread / Conversation | 一个 Task 可能跨多个 Conversation（执行过程中的多轮 sub-thread） |

### 当前不做的决定（留待未来明确）

- **Task 的 wire schema**：什么字段构成一个 task（目标、验收标准、deadline、参与者、SLA）
- **完成质量评估体系**：rubric 谁定义？模型自评 / 人审 / 自动测试三选几？
- **执行过程的持久化**：是否需要把执行中的 conversation/checkpoint 全量挂在 task 下
- **task ↔ member 的关系**：assignee 是单个 Member 还是一个 sub-team；agent 能否主动认领；返工如何流转
- **task 与 Conversation 的耦合度**：是 Conversation 的"长会话变体"，还是完全独立的运行模式

### 立场

- **承认它是 first-class 形态**——不把它当成"长一点的 conversation"硬塞进现有 thread/message 模型
- **暂不写代码**——MVP（M8）只支持 Conversation；Task 在 Member/Conversation（M10）落地后再单独立项
- **设计时为它留口子**——backend 的 SQLite 表设计、AgentEvent 协议、checkpointer 接口在演进时考虑"未来 task 可挂在上面"，不做会阻塞 task 的决定

→ Task 抽象的正式设计在能力组「长任务的派发、执行、验收」对应的 milestone 落地。该 milestone 在 Member/Conversation（M10）和 agent-as-tool（M11）就位后再开。

---

## 九、架构文档导航

**装配层与运行内核**

- [01-glossary.md](./01-glossary.md) — 术语表
- [02-framework.md](./02-framework.md) — 框架层设计
- [03-plugin.md](./03-plugin.md) — Plugin 扩展机制详解
- [04-checkpointer.md](./04-checkpointer.md) — Checkpointer 持久化与中断（M9 起职责收窄至 agent-resume）
- [05-context-manager.md](./05-context-manager.md) — ContextManager 上下文管理

**Plugins**

- [06-plugin-fs-memory.md](./06-plugin-fs-memory.md) — FS Memory（文件系统持久化记忆）
- [07-plugin-progressive-skill.md](./07-plugin-progressive-skill.md) — Progressive Skill（技能渐进式加载）
- [08-plugin-task-guard.md](./08-plugin-task-guard.md) — Task Guard（任务进度守卫：Plan + Todo + 热层验收 + 冷审评估）

**Harness**

- [09-harness.md](./09-harness.md) — Harness 的定义（两种形态 + bootstrap 协议）
- [10-harness-generic.md](./10-harness-generic.md) — Generic harness（file-driven 通用 harness）
- [11-harness-vs-framework.md](./11-harness-vs-framework.md) — Framework vs Harness vs Backend 边界

**Backend & Wire**

- [12-backend.md](./12-backend.md) — Backend Agent 托管服务（HTTP server + agent/thread 管理 + runner pool + M9 Durable Runs）
- [13-agent-spec.md](./13-agent-spec.md) — AgentSpec wire schema（Backend ↔ Runner 契约）
- [14-event-log.md](./14-event-log.md) — EventLog 执行事件事实源（M9，从 Checkpointer 拆出，SSE 投影数据源）
- [15-conversation.md](./15-conversation.md) — Conversation 与 Member 抽象（M10，多成员会话模型）
- [16-resident-runner.md](./16-resident-runner.md) — Resident Runner：从 ephemeral 进程到常驻 sandbox 守护进程的迁移设计
- [17-agent-file-system.md](./17-agent-file-system.md) — Agent File System：agent 看到的虚拟文件树，WorkspaceFS + mount table + domain 模型

**Surfaces**（M13+ 引入后补充）

- _frontend / IM bot / CLI 设计文档待建_

---

**入口文档结束。** 实施细节进入各分册。