# 审批请求是产品的一等契约

> 状态：**Accepted**（2026-09-28；三家缝的实测契约见文末附录，落地进度见「后果」）。

## 背景

审批这件事今天只有 oma 能用。`resolveApproval` 只有 oma 适配器实现；审批请求的事件名 `backend.oma.approval_request` 被四处按名字识别；另外三个 CLI 后端跑的是 headless print 模式，**没有权限通道**：实测 `claude -p --permission-mode default` 遇到需要授权的命令直接拒绝（"requires approval in this environment and wasn't authorized"），omp 与 pi 的 print 模式连这个开关都没有。

产品侧那套东西却已经与后端无关：durable `pending_action`、卡片、期限、重放（`pendingActionEvents`）、ADR 0038 的重启恢复，全是产品能力。差异化的部分都在这里，所以要统一的正是这一层。

三家的第一方缝各长在不同地方，第三方桥的覆盖有洞：`pi-acp` 的 `request_permission` 只服务 pi 的扩展 UI 确认，且不接 MCP 服务器，pi 经桥拿不到工具审批；`claude-agent-acp` 则完整，权限、client MCP servers、`loadSession` 都有。

## 决策

1. **审批请求进核心事件集。** `approval_requested` / `ask_requested` 与 `native_tool_started` 同级，不再挂在 `backend.oma.*` 名下。oma 的 wire 名字不动，映射留在适配器内（ADR 0038 的既有行为不碰）。

2. **「先持久化、再广播」只允许一处实现。** 这条顺序保证今天写在 oma 事件的形状里（live bus 的 `broadcast`），抽象之后仍只保留 live bus 这一处；适配器不得自己做持久化，否则报文的可见顺序会跟着各家实现漂。

3. **各后端只做薄适配**，把自家缝接到契约上，不新增协议层：

   - oma：不变；
   - cc：`--permission-prompt-tool <我们的 MCP 工具>`，工具 `request_approval` 停靠 durable action，按 cc 的契约返回；
   - pi：一个 pi 扩展，用 `on("tool_call")` 拦截，问产品，回 `{block, reason}`；
   - omp：ACP 的 `session/request_permission`（omp 是唯一原生讲 ACP 的）。

4. **传输统一算副产品，有触发条件。** 只有当（a）有两个以上 agent 原生讲 ACP，或（b）桥补齐了工具审批与 MCP 接线，才建通用 `acp` kind。今天 omp 一个原生；cc 经桥可作第二目标；pi 经桥不达标。

5. **恢复跟状态所有权走**（沿用 ADR 0038 的判据）：action 记录、期限、卡片、答案归产品；agent 自己的策略（例如 cc 的 `PermissionUpdate` durable 规则）归 agent；产品只如实展示「将创建什么规则」，不假装能撤销。

6. **A2A 是另一个轴，不依赖 ACP。** 把 backend 暴露成 A2A agent 复用同一份契约：run 的 `waiting` 对应 A2A 的 `input-required`。任何非 loopback 暴露先过 ADR 0026 的检查项；A2A 作 client 是未来的第五个 `AgentBackend` 实现。

7. **不做：** 不做通用协议插件系统；不给 `pi-acp` 的洞打补丁（pi 走自家扩展）；不动 oma 的 RPC 与恢复机制。

## 后果

- **收益**：三家后端的 HITL 行为一致：同一套卡、同一个期限、同一份重放与重启恢复；A2A 的 `input-required` 顺带具备；现有产品的 durable 机制一行不用改。
- **代价**：改四处硬编码的事件名，事件契约加两个类型；cc 加一个 MCP 工具与一个启动参数；pi 加一个扩展；omp 要写 ACP 客户端，这是唯一需要写协议的一层。
- **风险**：cc 的 flag 是私有接口（`--help` 里没有，靠二进制与实测确认），版本漂移要盯；桥的版本耦合与失败面；A2A 规范仍在演进，只做我们需要的三样（Task、`input-required`、流式）。

- **落地进度（2026-09-28）**：决策 1 已落地。`approval_requested` / `ask_requested` 进核心事件集（`packages/agent-contract/src/event.ts`），oma 子进程的帧名不动，翻译在 `packages/adapter-oma-agent/src/event-mapper.ts`；后端四处硬编码的名字收口（bus 识别、重放合成、ask 广播、telemetry 白名单），其中重放合成从盲信 `action.payload` 改为校验读取，缺身份的旧行不再变成无法解决的卡；Web 与飞书改订新名，Web 那条裸字符串的订阅并回类型化客户端。决策 2 本就成立（顺序保证只在 live bus）。决策 3 的四个后端适配与决策 4 的通用 `acp` kind 尚未开工。

## 附录：三家缝的实测契约

2026-09-28 在本机（deepseek 网关 + omp 18.2.10 + claude 2.1.229）跑通，帧与返回值如下。

**cc `--permission-prompt-tool mcp__<server>__<tool>`**
入参：`{ tool_name, input, tool_use_id }`，另有 `_meta["claudecode/toolUseId"]` 与 `progressToken`。
返回：结果的 text 内容须是 JSON：`{"behavior":"allow","updatedInput"?}` 或 `{"behavior":"deny","message"}`；返回非 JSON 会被判失败并 fail-closed（模型收到错误）。
行为：allow 后工具真执行，deny 后不执行。
基线：不给该 flag 时，`-p --permission-mode default` 直接拒绝危险命令。

**cc 官方 SDK 的 `canUseTool(toolName, input)`**
`@anthropic-ai/claude-agent-sdk` 在 Bun 上可跑；回调返回 `{behavior:"allow", updatedInput}` 即放行。VS Code 官方扩展走的就是这条缝（其 bundle 里 `canUseTool` 出现 14 次，`--permission-prompt-tool` 由 SDK 拼给 CLI）。

**omp `omp acp`**
`initialize` 声明 `loadSession: true`；权限请求形如：

```
session/request_permission {
  toolCall: { toolCallId, title, kind:"execute", status:"pending",
              rawInput:{ command, timeout, cwd, pty, async }, content:[{type:"content",…}] },
  options: [allow_once, allow_always, reject_once, reject_always]
}
```

客户端回 `{outcome:{outcome:"selected", optionId}}` 或 `{outcome:{outcome:"cancelled"}}`。
开关：`--approval-mode always-ask`；默认配置会静默放行，根本不发权限请求。
续跑：新进程 `session/load {sessionId, cwd, mcpServers}` 能恢复旧会话。

**pi 扩展的 `on("tool_call")`**
pi 核心没有工具审批策略（`approvalMode` 一类配置不存在）。扩展收到 `{ type:"tool_call", toolCallId, input }`，返回 `{ block?: boolean, reason?: string }` 即可拦住。`pi-acp` 桥的 `request_permission` 只覆盖扩展 UI 确认，不覆盖工具审批，也不接 MCP 服务器。
