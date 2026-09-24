# Product Tools 的身份取自 run token，不取自模型参数

## 背景

`product-tools/mcp.ts` 原来这样确定「我是谁」：优先读 `call params._meta.identity`，没有就读模型传的 `identity` 参数，然后拿其中的 `runId` 跟 bearer token 里的 run**比对**，不一致就拒绝（"identity does not match the session's authenticated run"）。

两个事实让这套机制站不住：

1. **没有任何生产 MCP 客户端附 `_meta`。** `packages/adapter-mcp` 的 `callTool(serverId, toolName, args)` 不带 meta，oma 的挂载层也不注入 identity；全仓只有测试夹具描述过那个形状（夹具注释还写着「production wire shape」，是假的）。于是模型手抄的 `identity` 参数成了唯一通道——而它抄的是 prompt 里 24 位不透明 id。
2. **模型会抄错。** 实测在线连续拒绝合法调用：`todo_write` 一次、`ask_question` 两次，模型的收尾原话是「弹窗工具连续两次报 identity 不匹配（runId 轮换导致身份对不上）」，随后**放弃问答卡片、改用纯文本提问**——用户看到的是「有 ask 但没有按钮」，且完全无从修复。

与此同时，per-run bearer token（mint-at-dispatch / revoke-at-settle，`run-token-registry`）**已经落地**，它本身就唯一确定了 run。`execution-input.ts` 里那条「硬绑定需要 per-run token（待办）」的注释已经过时。

## 决策

**身份取自 token，不取自参数。**

- `mcp.ts` 的 run/agent 取自 SSE 会话的 bearer token context；`identity` 参数不再参与授权判定。
- `_meta.identity` 仍然校验：那是**子进程自己的 wire identity**，不一致意味着串线/陈旧进程，属于真实故障（若将来有客户端开始附带它）。
- `service.assertScope` 改为「未提供的字段不算不匹配，写了且不同才算」：作用域的唯一真源是 run 行（"scope is ALWAYS derived from the run, never trusted from MCP arguments"），MCP 层只知道 token 携带的 run + agent。
- `idempotencyKey` 由后端用权威 runId 现场构造，回调参数里的同名字段不再能破坏 `${runId}:${callId}` 不变式。
- 系统提示里的 identity 块降级为**参考信息**（模型仍需要知道自己在哪个 run，以及当前任务清单），不再要求「必须把 identity 作为参数传入」。

## 后果

- 产品工具不再因为模型记错一个 id 而失败；这是本轮「卡片计划条 / 问答按钮不生效」两处症状的前置障碍。
- 伪造参数无法把调用导向别的 run：run 由 token 决定，参数里写什么都没用。
- 失去的是「模型参数与 token 交叉校验」那层防护——它本来就不构成安全边界（token 才是权威），代价只是少了一条冗余检查。
- ADR 0027 中「CLI 后端经 `identity` arg 传 runId/callId」「`_meta` 缺失时的 arg-identity 回退」两处描述**已被本决策取代**。
