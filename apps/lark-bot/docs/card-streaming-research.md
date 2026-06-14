# 飞书卡片流式渲染 — 前期调研

> 2026-06-14 · 基于 lark-cli v1.0.53 + 飞书卡片 JSON 2.0 文档

## 一、目标

M15 当前只发纯文本最终回复。下一步（M16+）要做到：agent 生成回复的过程中，Lark 端以**流式卡片**逐步展示内容——类似 ChatGPT 的打字效果，但以飞书卡片为载体。

## 二、关键 API

### 2.1 发送卡片消息

```
lark-cli im +messages-send \
  --chat-id oc_xxx \
  --msg-type interactive \
  --content '<card JSON>' \
  --as bot
```

`--content` 接受完整卡片 JSON 字符串。卡片的 `msg_type` 必须为 `interactive`。

**测试验证**（用真实 bot 发送空卡片）：

```bash
lark-cli --profile fixture-test im +messages-send \
  --chat-id oc_1be93c7998ef23f0a96e947d5fb04b43 \
  --msg-type interactive \
  --content '{"schema":"2.0","config":{"streaming_mode":true},"body":{"elements":[{"tag":"markdown","content":"⏳ 思考中..."}]}}' \
  --as bot
```

### 2.2 更新卡片（流式追加内容）

飞书 OpenAPI 支持 PATCH 更新已发送的卡片：

```
PATCH /open-apis/im/v1/messages/{message_id}
```

通过 lark-cli：

```bash
lark-cli api PATCH "/open-apis/im/v1/messages/{message_id}" \
  --data '{"content":"<updated card JSON>"}' \
  --as bot
```

**关键约束**：
- 只能更新 `msg_type=interactive` 的消息
- 更新时需要传**完整卡片 JSON**（非增量 patch）——客户端用新的完整 JSON 替换渲染
- 需要在卡片 JSON 中设置 `config.update_multi=true`（共享卡片）

### 2.3 流式模式配置

在卡片 JSON 的 `config` 中启用流式模式：

```json
{
  "schema": "2.0",
  "config": {
    "streaming_mode": true,
    "streaming_config": {
      "print_frequency_ms": { "default": 30 },
      "print_step": { "default": 2 },
      "print_strategy": "fast"
    },
    "summary": { "content": "生成中..." },
    "update_multi": true
  },
  "body": {
    "elements": [
      { "tag": "markdown", "content": "" }
    ]
  }
}
```

- `streaming_mode: true` — 告诉客户端这张卡片会持续更新
- `streaming_config.print_step` — 每次渲染的字符步长
- `streaming_config.print_frequency_ms` — 渲染频率（ms）
- `summary.content` — 聊天列表中的预览文案，流式模式下默认 "生成中..."

## 三、与当前架构的集成点

### 3.1 当前数据流

```
agent run → AgentEvent(delta) → event_log → (目前只读最终)
                                           → (未来: SSE watcher 读 delta)
```

### 3.2 流式方案

```
agent run → text_delta → SSE watcher 捕获
                       → lark-cli PATCH /messages/{msg_id}
                       → 飞书客户端逐字渲染
```

**方案 A：SSE watcher 扩展**

当前 lark-bot 的 `sse-watcher.ts` 只订阅 `/conversations/:id/events`（ledger），不订阅 `/runs/:id/events`（event_log delta）。流式需要额外订阅 run 级 delta stream：

```ts
// 新增：run-level delta watcher
function watchRunDelta(runId: string, messageId: string, larkChatId: string) {
  // 1. 先发送占位卡片
  const msgId = await sendCard(larkChatId, placeholderCard);

  // 2. 订阅 run delta events
  const stream = fetch(`/api/runs/${runId}/events`);

  // 3. 每次 text_delta 追加到卡片内容
  for await (const delta of stream) {
    accumulated += delta.text;
    await updateCard(msgId, buildCard(accumulated));
  }

  // 4. run 结束后发送最终版本（或让最终消息覆盖）
}
```

**方案 B：D19 后批量发送**

agent 跑完后一次性发卡片——不走流式，但可以利用卡片的 markdown 组件展示富文本。这是 MVP 之后的第一步升级，先拿到卡片展示能力，再叠流式。

### 3.3 需要新增的能力

| 能力 | 优先级 | 说明 |
|------|--------|------|
| `sendCard(chatId, cardJson)` | P0 | 发送卡片消息，替代 `sendText` |
| `updateCard(messageId, cardJson)` | P0 | 更新已有卡片 |
| `runDeltaWatcher` | P1 | 订阅 run 级 delta event |
| `textToCardRenderer` | P1 | 将流式文本增量转换为卡片元素 |
| `templateCardBuilder` | P2 | 预设卡片模板（思考中/生成中/完成/错误） |

## 四、卡片组件速查

### 4.1 Markdown 组件（推荐用于 agent 输出）

```json
{
  "tag": "markdown",
  "content": "## 分析结果\n\n- 项目：**my-agent**\n- 状态：✅ 通过",
  "element_id": "agent_output"
}
```

支持飞书 markdown 语法：标题、加粗、列表、代码块、链接、图片。

### 4.2 文本组件

```json
{
  "tag": "plain_text",
  "content": "简单文本",
  "element_id": "status_text"
}
```

### 4.3 按钮组件（交互回调）

```json
{
  "tag": "button",
  "text": { "tag": "plain_text", "content": "确认" },
  "type": "primary",
  "element_id": "btn_confirm",
  "value": { "action": "confirm" }
}
```

按钮点击会产生 `card.action.trigger` 事件——需要 lark-bot 订阅该事件类型才能响应。这是未来交互式审批/确认的基础。

### 4.4 布局容器

```json
{
  "tag": "column_set",
  "flex_mode": "bisect",
  "columns": [
    { "tag": "column", "elements": [...] },
    { "tag": "column", "elements": [...] }
  ]
}
```

## 五、流式性能参数

飞书客户端对流式卡片有内置的去抖/聚合机制（`streaming_config`）。服务端不需要做逐 token 推送——可以用更大的 chunk（如每 100ms 或每 5 个 token 推一次）：

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| `print_frequency_ms.default` | 50 | 50ms 刷新间隔 |
| `print_step.default` | 3 | 每次刷 3 字符 |
| `print_strategy` | `fast` | 快速策略（优先速度） |

实际推送频率建议：**每 100-200ms 更新一次卡片**，每次包含当前完整文本。这比逐 token 推送更稳定，也降低了 API 调用量。

## 六、与当前 `sender.ts` 的对比

| | 当前 `sendMessage` | 流式 `sendCard` |
|---|---|---|
| 传输 | `lark-cli im +messages-send --text` | `lark-cli im +messages-send --msg-type interactive --content` |
| 更新 | 不支持 | `lark-cli api PATCH /im/v1/messages/{id}` |
| 去重 | `--idempotency-key` | 同上 |
| 内容 | 纯文本 | 卡片 JSON（支持 markdown/布局/交互） |

## 七、风险与限制

1. **卡片 JSON 大小上限**：未在文档中明确，但推送 body 通常限制 ~100KB。超大回复需要截断或分页。
2. **更新频率**：飞书 API 限流约为 100 次/分钟/应用。流式推送需控制频率（建议 ≤30 次/分钟）。
3. **客户端兼容**：卡片 JSON 2.0 需要飞书客户端 ≥7.20。老版本会显示升级提示。
4. **共享卡片约束**：`update_multi` 必须为 `true`——所有群成员看到同一张卡片的更新。群聊场景是期望行为；P2P 无影响。
5. **PATCH 是全量替换**：不是 incremental patch——每次需要传完整卡片 JSON。内存中需要维护当前卡片状态的完整副本。

## 八、建议推进路径

1. **M15.x**（当前）— 保持文本发送，验证 E2E 稳定性
2. **M16 卡片基础** — 实现 `sendCard` + 简单的 markdown 卡片模板，agent 最终回复改为卡片格式
3. **M17 流式卡片** — 实现 `runDeltaWatcher` + `updateCard`，agent 输出逐段推送到卡片
4. **M18 交互卡片** — 按钮/表单回调，订阅 `card.action.trigger` 事件，实现审批/确认交互
