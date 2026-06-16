# Packages

`packages/` 是整个 agent 系统的可复用内核,按职责从底到上分层:最底下是不依赖任何运行时的协议类型,往上是 agent 循环、插件框架、开箱即用的封装,再到一组支撑设施(沙箱文件系统、事件日志、runner 进程与协议、观测)。`apps/` 下的后端与各 surface 都是把这些包拼起来用。

设计上的一条主线是:**依赖只能向下**。`core` 处在最底层且零依赖,所有人都对齐到它定义的消息、模型、工具类型;越往上的包越"有主张",但永远不会被下层反向依赖。

## 分层导航

**协议与类型(零运行时依赖)**

- [`core`](./core/):定义 `Message`、`ContentBlock`、`ChatModel`、`Tool` 这套通用词汇,并提供最小的 `run()` 工具调用循环。整个系统的地基。
- [`agent-spec`](./agent-spec/):agent 的声明式规格(zod schema),作为后端与 runner 之间传递 agent 定义的线缆格式。
- [`conversation`](./conversation/):多方会话领域模型——会话、成员、账本条目、@mention 触发规则。

**框架与插件**

- [`framework`](./framework/):`createAgent()`——把模型、工具、插件、上下文管理、检查点、中断/审批组合成一个可运行 agent 的核心。
- [`plugin-fs-memory`](./plugin-fs-memory/):基于文件系统的长期记忆插件。
- [`plugin-progressive-skill`](./plugin-progressive-skill/):SKILL.md 渐进式加载插件,按需分页把技能正文喂给模型。
- [`plugin-task-guard`](./plugin-task-guard/):规划 + 进度跟踪 + 停止前确定性把关插件。

**封装**

- [`harness`](./harness/):`createGenericAgent()`——把上面这些默认值一次性接好的"开箱即用"agent。

**支撑设施**

- [`agent-fs`](./agent-fs/):基于能力(capability)的沙箱虚拟文件系统,用挂载点约束 agent 能读写的范围。
- [`event-log`](./event-log/):持久化的只追加事件存储,支持订阅与尾随(SQLite 实现)。
- [`runner-daemon`](./runner-daemon/):每个 agent 一个的常驻沙箱执行进程。
- [`runner-protocol`](./runner-protocol/):runner 与后端之间的 NDJSON 消息类型与 Unix socket 传输。
- [`runtime-observability`](./runtime-observability/):OpenTelemetry 链路追踪、指标与敏感信息脱敏。

**工具与适配器**

- [`tools-common`](./tools-common/):标准工具实现——bash、文件读写编辑、grep、glob、网络、记忆等。
- [`adapter-anthropic`](./adapter-anthropic/):`AnthropicChatModel`,全仓唯一直接 import 模型 SDK 的地方。

**测试**

- [`test-helpers`](./test-helpers/):`echoModel()` 等确定性的 ChatModel 测试替身。

## 从哪读起

- **想理解整体**:`core` → `framework` → `harness`,顺着这条线就能看懂类型契约、插件组合、以及一切如何拼起来。
- **想加插件**:先看 `framework` 的插件契约,再照着任一现有 `plugin-*` 抄结构。
- **想接新模型厂商**:看 `core` 的 `ChatModel` 接口,照着 `adapter-anthropic` 写适配器。
- **在做后端**:`agent-spec`(线缆格式)→ `runner-protocol`(消息与传输)→ `runner-daemon`(socket 另一端发生了什么)→ `event-log`(事件如何持久化与推流)。
