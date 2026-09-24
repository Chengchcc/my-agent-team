# 工具活动行是唯一跨进程的展示字段（原始 input 不过界）

Web 气泡与飞书卡片都需要回答「这个 Run 现在在做什么」。此前线上 `native_tool_started` 只带 `toolName`/`callId`，于是每个界面各自从工具名反推摘要：飞书卡片有一张 `read → 读取文件`、`bash → 执行命令` 的映射表，Web 只能干显示工具名。两侧都会漂移，而且那张表是在**声称**自己知道工具在做什么——它并不知道跑的是哪条命令、读的是哪个文件。

另一条显然的捷径是把 `input` 直接搬到线上。它被否决：工具的 input 里有完整 bash 命令、绝对路径、MCP 参数、用户输入、token/URL/header、大文本引用。一旦过界，backend、Web、飞书的每一处日志与通知都成了这些内容的落点，而且每个 surface 都得理解各类工具的参数才能渲染。

## 决策

1. **工具自己声明活动描述。** `Tool.describeStart?(input): string | undefined`（`packages/message/src/tool.ts`）。语义是「用户可见的活动」，不是「input 的缩略版」，所以命名刻意避开 `inputSummary`——后者会诱导出 `JSON.stringify(input).slice(0, 160)`。返 undefined 表示这个工具说不出活动，界面只显示工具名。
2. **`input` 永不跨进程——靠写出点的收窄，不是靠映射层的省略。** `tool_execution_start.input` 只服务 oma 内部的 transcript/TUI；跨边界的是 `activity`。收窄点在 **RPC 帧写出处**（`rpc-mode.ts` 的 `onEvent` 调用 `protocol/mapping.ts` 的 `forWire`），不是 `mapRunEvent`：帧先写到 stdout、被适配器与 backend 看到，映射是**消费侧**的事，指望它拦住已经太迟（首版就是这么写的注释，被 review 抓出与事实不符）。进程内消费者（TUI 读 `input` 画工具卡）看的是未收窄的 envelope，所以收窄落在写出点而非 envelope 构造处。
3. **清洗只在一处。** `safeToolSummary`（`core/tools/presentation.ts`）：单行化、去 ANSI、截断 160 字、脱敏常见凭证（`gh[pousr]_`/`sk-`/`xox[baprs]-`、`Bearer …`、`Basic <base64>`、`curl -u user:pass`/`--user`、`api_key=…`、URL 的 `user:pass@`、AWS key id）、拒绝控制字符、为空则回退。它刻意不做通用 input formatter——只有工具自己知道该展示什么。
4. **契约先改。** `packages/agent-contract` 的 `BackendEvent.native_tool_started` 声明 `activity?: string`，再依次落 oma 工具合约 → loop → oma 事件 → mapping → 适配器 → `api-contract` 的 `runEvents` → Web → 飞书。只在 oma mapping 里 `as` 一个扩展字段是未声明的 JSON 漂移，不允许。
5. **产品工具不走这条路。** `todo_write` 由 `backend.oma.todo_update` 呈现、`ask_question` 由 `backend.oma.ask_requested`、审批由审批帧；它们的 MCP 调用在线上仍是 `native_tool_started`，但两端渲染时按工具名挡在通用过程步之外。否则只剩「正在调用 todo_write」这种把有语义的事件降级成噪音的行。
   判断必须**按叶子名**匹配：线上名字是 MCP 全限定形式 `mcp__product-tools__todo_write`（backend workspace-bridge 的 `.mcp.json` 与 oma `mcp-mount.ts` 的 `mcp__<server>__<tool>` 共同决定），用 `name !== "todo_write"` 直等**永远不命中**——Web 的四处过滤与飞书首版都是这么写的，等于这个功能从未生效。名单收敛在 `packages/api-contract` 的 `DEDICATED_EVENT_TOOLS` / `hasDedicatedEvent()`，两端共用。
6. **MCP 工具默认只给名字。** 外部 MCP 的参数不该默认展示（`正在调用：database query SELECT * FROM users`）；要展示得由该工具显式声明 `describeStart`。界面可对 `mcp__<server>__<tool>` 做名字可读化，但不声称任何参数。
7. **界面不得从工具名合成摘要。** 没有 `activity` 就显示工具名（飞书 `正在调用 bash`）。这是诚实性约束，不是样式偏好。

## 后果

- 活动行的质量取决于各工具是否声明 `describeStart`。已有：`bash`、`read`、`write`、`edit`、`grep`、`glob`、`eval`。未声明的工具（外部 MCP、`browser`、`web_search` 等）在界面上只有名字。
- `adapter-omp-agent` 的事件不带活动字段，omp 后端至今没有这一层，所以 omp Run 永远是名字回退——要在 omp 侧补齐，得先在 omp 自己的工具合约里加等价概念。
- `native_tool_started` 在 telemetry 白名单里，所以 `activity` 会随 `agent_run_event` 落库（用于 ops 瀑布），也就是活动行进库；脱敏在子进程完成，落库的是清洗后的字符串。
- 增加一个工具的成本多了一行「这个工具在做什么」的声明；不声明的代价是界面退化成工具名，而不是暴露参数。
- **仍未收敛的一处**：`backend.oma.ask_requested` 的 `questions` 在 `api-contract` 里只声明到 `z.array(z.unknown())`——权威形状是 `agent-contract` 的 `AskQuestionItem`，而 `api-contract` 刻意不依赖它（不同边界），手抄一份字段就是第三份会漂移的副本。正解是 backend 在发事件前就把它校验成 DTO，届时两端都不需要各自解析；在此之前飞书卡片是防御式解析（`parseAskQuestion` 逐字段判类型，拿不到就退回非交互帧）。
- 飞书卡片按钮回调**没有发送者白名单**（`allowedSenders` 只管入站命令）：同一会话里任何成员都能点批准/拒绝/回答。单用户本地部署（ADR 0026）下不构成新增暴露面，`operator_id` 只进日志留痕；多操作者部署前必须补签名 action token（见 ADR 0031 决策 6）。
