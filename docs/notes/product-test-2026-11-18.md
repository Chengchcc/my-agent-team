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

- `next dev` 首次编译大页面（`/team`、`/system/runs/*`）会顶到 2.6–3G，本机 4G 可用下会被 memguard 杀掉（137）。按技能清孤儿 `next-server` 后可重启；run 详情页因此改用 BFF/SSR 数据核对。
- 无头 Chromium 没装 CJK 字体，截图里中文显示为方框；应用本身正常（真浏览器不受影响）。

## 下一步候选

1. **让③④闭环**：给"这一轮到底问没问人"一个可判定的事实（例如：run 终态时若模型文本含问句而没有 ask 记录，标 `unasked_question`）——比再润色提示词更有牙。
2. run 详情页在低内存机器上的可测性（轻量页或预构建）。
