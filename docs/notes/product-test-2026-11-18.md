# 产品级走查（2026-11-18，隔离栈 + 真实模型 + 真浏览器）

目的：不看单测，按人的路径走一遍——登录 → 建房间 → 说话 → 派单 → 工人干完 → 前台改写 → 看收件箱 / run 详情。

## 环境

- 后端隔离 dataDir、独立端口与 token；web 用 `next dev`（memguard 上限按 `free -m` 给）；
- 两台 agent：前台 `default`、工人 `Worker One`（`role: worker`，均 `yolo`）；
- 工人工作区放了一个**失败**的小仓库（`src/auth` + `bun test`）。

## 走通的

1. 登录、Sidebar、Today 空态、Chat 表面、右侧 Run Diagnostics（内存/成本/上下文/MCP/工作区文件）。
2. 从 Composer 发消息（Ctrl+Enter 不生效，**Send 按钮**可用）。
3. 前台读工作区 → 发现代码不在自己工作区 → **派给 Worker One**（后台 run 的 `authorization=dispatch:default`、`parent_run_id` 指向前台 run）。
4. 工人执行：`read` / `bun test`（先 1 fail）/ `edit` / `bun test`（pass）。
5. 前台收到回填后**改写**成人话（根因、改动、验收），并说明"没有第二份独立复跑"。
6. 右侧 **VERIFICATION** 面板：`ran verification: yes / tool errors: 0 / eval used: no / agent claimed done: no` + 实际命令。

## 走查抓到的四个真问题

### ① 执行单元折叠块在真页面里从不渲染

原因两层：`runIdOf` 读的是 `m.content.id`，而 AHP 投影把账本 id 放在**时间线 item** 上（`content` 只有 `{role,text}`）；修好后又发现 agent 的回复根本走 `ReasoningTrace`（turn 分支），而折叠块被挂在只渲染人的消息的 single 分支上。**连带 artifact 挂载也一直是死的**（同一函数）。

修：`runIdOfSource(m.id)` + 把块挂到 turn 分支。单测补 `runIdOfSource`。

### ② 折叠块显示原始 agent id

`b18e189f…` 摆在写着「Worker One」的成员 chip 旁边。修：用 `useAgentList` 解析名字。

### ③ `ask_question` 被原生工具遮蔽，且失败不报错

真机证据：模型调用裸名 `ask_question`，返回 `{"error":"no ask pipeline configured","isError":false}`，于是它降级成**散文提问**，收件箱永远收不到这条债务。

原因：产品工具的 `ask_question` 是**经 ACP 以 code plugin 注入**的，而"注入优先"的谓词只扫 `.mcp.json` 挂载的工具名（todo 的老坑换了通道重演）。

修：谓词纳入 `codePlugins` 的工具名（有测试，变异会红）；原生工具缺管线时返回 `isError: true`（诚实失败，不许静默降级）。

### ④ 纪律在真机上不绑定

修好③之后再问一次同样含糊的话，模型**根本没调工具**，直接散文问。ADR 0061 D4"问题只能通过 ask 工具到达人"在真机上没有稳定生效——这条目前靠提示词，而提示词不是边界。

## 环境限制（不是产品缺陷）

- 机器是 **8G**（`free -m`: total 7398MB / 2 核）。被 137 杀掉不是因为内存小，而是**走查期间可用只有 ~4G**：agent 自身环境就占了 ~3.4G（omp 本体 1.1G、无头 Chromium 浏览器+renderer ~0.6G、ollama 0.45G、omp worker），而 `next dev` 首次编译 `/team`、`/system/runs/*` 这类 3000+ 模块的页面峰值 2.6–3G。两者相加超过了当时的余量，memguard 按其 cap 杀掉进程（这是它该有的失败方式：快失败而不是让内核挑受害者）。
- 结论：**跑 web 走查前先关掉不需要的浏览器标签和后台服务**，把 cap 按当时的 `free -m` 可用值给；`next-server` 孤儿要一起杀（内存能立刻回落）。run 详情页在没有余量时改用 BFF/SSR 数据核对。
- 无头 Chromium 没装 CJK 字体，截图里中文显示为方框；应用本身正常（真浏览器不受影响）。

## 下一步候选

1. ~~让③④闭环~~（已按"只观察"落地）：run 终态时若**最后一段**在问人（排除代码块里的问号）且该 run **没有任何 ask 记录**，写一条 `unasked_question` 遥测行。**不改进 UI、不改变行为**——先量真实命中率；文本启发式必然有假阳性，把它们摆进收件箱等于拿噪声训练人忽略收件箱。看到数据后再决定要不要升格成债务。
2. run 详情页在低内存机器上的可测性（轻量页或预构建）。

## 第二轮（会议室/展厅真机，2026-11-18 晚）

隔离栈：backend :3913（`/tmp/verify`）+ web :3001（memguard 3000M）。派单链真机跑通：前台 `5ccfaad0` → 工人 `43a4c6c9`（verdict pass，改前 1 fail → 改后 1 pass）。

### 验到的

| 事实 | 证据 |
|---|---|
| 房间只画人和前台 | 时间线只有 seq 1/2/59/69；工人的 `mcp__product-tools__report`、`bun test` 都不在房间里 |
| 展厅链路通 | 前台 run 页 `Dispatched units` 显示 "Worker One"（不是裸 id）→ `Open` → 工人 run 页 |
| 下车间真的到工人 | 房间发一句 → 新 run `ae46af71e7`（`parentRunId` 空）、`authorization=user`、前台不被触发 |
| 摘要进房间 | 房间那行前面有 `→ Worker One` 标签（title "said directly to Worker One"） |
| `unasked_question` 遥测 | run `a519fdf884` 收尾"你拍板选哪个？"且未开 ask ⇒ 记 1 条（tail 完整） |

### 抓到的两个真问题（已修）

1. **摘要另起一行在房间里不可见**：房间渲染的是 `chatState.turns`（启动过 run 的消息），没有 run 的裸账本行根本不画。改成挂在人那条消息上（`_meta.floorFor`），并且必须进 `MessageRevisionSchema` —— 落账走 `MessageRevisionSchema.parse`，未知字段会被静默剥掉（第一次真机就是这个原因）。
2. **派过一次活之后，房间里不带 @ 的话彻底没反应**（ADR 0041 群聊语义 + 工人成为成员 ⇒ 只落账不触发，`triggeredRuns` 空、无报错）。这是我按"下车间"发指令时撞出来的。修法见 ADR 0066 D5：`addressedTo` **缺省**且非观察渠道 ⇒ 交给房间常驻者（前台）；`addressedTo: []` 仍表示"没人"；Lark 保持观察语义。

### 仍未绑定

ADR 0061 D4"问题只能通过 ask 工具到达人"：这次真机再次是**散文提问**——遥测记到了，但收件箱不会响。要不要把 `unasked_question` 升格成债务，等命中率数据。
