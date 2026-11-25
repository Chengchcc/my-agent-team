# ADR 0081: Web 一次切到 oh-my-agent 设计——共享会话内容、建议不等于保存、不留灰度开关

- 状态: Accepted（决策已定；实现按波次推进，进度见文末）
- 日期: 2026-11-25
- 相关: ADR 0040（提议由页面采纳）、ADR 0061（注意力债）、ADR 0074（超级助理）、ADR 0076（只推 agent 分支）、ADR 0079（界面语言是皮肤）

## 背景

交互原型（`prototype-ui`，116 项离线行为检查通过）定下了 Web 的目标形态：Lark 是主入口，Web 负责注意力、查看结果和管理。把原型落到现有前端时要守住三件事：保留真实会话、执行、工作区和权限链路；原型里的模拟数据和模板规则不进生产；接口不够的地方如实标出，不用界面假装完成。

取证时发现一处与目标直接冲突的现状：`agent_config` 提议被编辑页轮询到后直接 `adopted`，后端随即写入真实 agent（`features/agents/config-mcp.ts`、`proposal/apply.ts`）。表单还显示未保存，服务端已经落盘，和工具文案「NOT saved … Save to apply」相反。原型的核心约定恰好是：生成建议、采纳到表单、保存资源是三件事。

本 ADR 的初版按「分批迁移加一个灰度开关」写。产品决定改了：控制台是内部工具，新旧两套界面并存的时间越长，要维护的入口越多，所以不留开关，整个控制台一次改到原型的设计，主题也整站替换。

## 决策

### D1 一次切换，不留开关

没有 `localStorage` 开关，也没有按页面选择新旧界面的路径。一个页面迁完，它的旧入口就删掉。回滚方式是整批 revert 这组提交，不涉及数据迁移：这次改动不新增表、不改已有列的含义，后端只多了一类提议（D3）。

分批只体现在提交顺序和工作安排上，不体现在用户能不能看到旧界面。

### D2 会话内容只有一个实现，按密度缩放

`ConversationPanel` 持有消息、实时状态和输入框，以真实 `conversationId` 为键。页面外壳（头部、roster、诊断、深链自动发送）留在 `ConversationCanvas`，侧栏和内嵌视图直接用同一个面板。

原型对同一套会话组件用了两种尺度：聊天页（正文 12px、头像 34px、人的气泡是中性色）和编辑侧栏里的面板（正文 11px、头像 30px、人的气泡带薄荷色）。按宽度写的媒体查询区分不了这两者——1440 的桌面上侧栏只有 660 宽——所以由嵌入方通过 `density="page" | "panel"` 说明，面板把它放进 context，消息行和输入框据此缩放。

`useConversation` 返回具名的 `ConversationController`，消费方依赖契约而不是钩子内部结构。

### D3 建议不等于保存

PA 通过受控工具提出的改动是一条 proposal 行。表单旁边用 `ProposalCard` 展示它：字段、当前表单值、建议值，逐字段标出有没有变化。

- 「采纳到表单」只把建议值填进草稿，不写任何东西。
- 表单保存是唯一的写入。保存时带上行 id 和人审阅后的表单值：`POST /api/proposal-decisions/:id {decision:"adopted", payload}`。后端只取该类提议能携带的字段，目标不变，应用这份值，并把它记回行里。
- 表单在建议到达后被人改过，建议即过期：不能再采纳，界面说明原因，请重新提出。
- 行仍只能被决定一次。另一个视图先决定了，表单退回普通的更新接口，因为人审阅过的值才是要保存的。

`adopted` 的含义不变，仍是「已应用」。从收件箱直接采纳，应用的还是工具送来的那份值。所以收件箱只对两类项目提议提供「采纳」；`agent_config` 跳到成员编辑页，`workflow_definition` 跳到工作流编辑页，在那里应用只填表单。

成员是这个规则的一个变体，因为后端对 `agent_config` 不收审阅值：决定接口应用的是行里存的那份 payload。成员编辑页的做法是「先保存表单，再结清这行」：

- 保存永远写人审阅过的表单。
- 之后，如果建议被应用过且它点名的每个值都原样保存了，这行记 `adopted`——注册表会再应用一次存着的 payload，对这些字段是同一次写入。
- 人改过其中任何一个值，这行记 `discarded`。
- 新成员的建议目标是不存在的草稿 id，建成员走的是表单，所以总是 `discarded`。

没有选「值没变就用采纳代替保存」，因为那会丢掉建议没点名的字段上、人在建议到达前后做的修改。

项目是第一个资源：新增 `project_update` 类提议，由 `project_propose {project_id, …}` 产生；不带 `project_id` 时仍是提议新项目。

### D4 斜杠列表里的 Skill 只是点名

输入 `/` 时，列表在客户端命令之后列出所选 PA 已绑定技能包里的 Skill（来自技能包接口的真实数据）。选中只是把名字写进消息，发出去仍是一条普通消息，由 agent 决定是否加载该 Skill。没有工具在发送路径上执行。

### D5 打开侧栏不算看过这段会话

`ConversationPanel` 的 `marksSeen` 说明「显示这段会话算不算这个人看过它」。聊天页是 `true`；嵌在编辑侧栏等别的东西旁边的面板是 `false`——打开一个编辑器不应清掉那段会话的未读标记和注意力债（ADR 0061）。

### D6 编辑侧栏里的 PA 会话接最近的会话

PA 面板默认接该 PA 最近的一个会话（产品决定）。这可能是 Lark 私聊对应的那个会话，管理对话和日常对话会混在一起。要不要为管理单独开会话，留待产品决定；现在的选择是不新建会话。

### D7 主题整站替换，不留两套调色板

`globals.css` 的 `:root` 直接换成原型的中性底色加薄荷色强调（底 `#101214`、面板 `#181b1e`、浮起 `#202428`、文字 `#eff1ee`、次要 `#a1a7a9`、主色 `#b4f1d1`），派生别名（`--primary-soft`、`--primary-deep`、`--on-primary`、`--ok-soft`、`--accent-violet`、图表色）一并重映射，不留旧的青色碎片。正文是原型的 14px/1.6，字体栈带上中文字族，底色不再有点阵。页面不出现两套主题，所以不存在闪烁和hydration 不一致的问题。

### D8 一个英文键只有一种译法

各页面的词典放在 `apps/web/src/lib/locales/pages/`，合并进总词典。合并顺序曾经能悄悄决定全站显示哪个词（同一个键在两个文件里译法不同时，后展开的赢）。现在 `lib/locales/pages/index.test.ts` 规定：一个键在任何两个词典里译法必须相同，新增的页面词典必须登记并合并。含义确实不同的，改键名，不改合并顺序。

## 不变量

1. 界面在用户保存之前不写资源；采纳建议、关闭侧栏、已读都不算保存。
2. 一个 proposal 只被决定一次；失败的保存让行保持 pending，表单草稿不丢。
3. 关闭侧栏只取消该视图的订阅和计时器，不删会话，不改草稿以外的任何记录。
4. 同一会话在聊天页和侧栏里是同一份消息、同一个输入队列。
5. 控制台只有一套界面。回滚靠 revert，不靠运行时开关。
6. 原型里有、接口里没有的数据，界面如实写「未提供」，不用占位数字凑版式。

## 落点

| 层 | 文件 |
|---|---|
| 共享会话 | `apps/web/src/components/ConversationPanel.tsx`、`conversation-density.ts`、`hooks/useConversation.ts`、`components/Composer.tsx` |
| 宽侧栏 | `apps/web/src/components/ui/resource-editor-sheet.tsx` |
| 建议卡片 | `apps/web/src/components/ProposalCard.tsx` |
| 主题与版式 | `apps/web/src/app/globals.css`、`components/ui/*` |
| 导航外壳 | `apps/web/src/components/NavRail.tsx` |
| 共享 PA 会话 | `apps/web/src/components/PaSession.tsx`（选 PA、选会话、起草请求）、`AskPaSheet.tsx` |
| 页面词典 | `apps/web/src/lib/locales/pages/*.ts`、`pages/index.test.ts` |
| 项目编辑样例 | `apps/web/src/components/ProjectEditorSheet.tsx`、`ProjectFields.tsx`、`ProjectForm.tsx`、`features/projects/{editor-model,project-form,queries}.ts` |
| 提议契约 | `apps/backend/src/features/proposal/{domain,apply,http,service,adapter-sqlite,ports}.ts` |
| 工具 | `apps/backend/src/features/product-tools/{dispatch,manifest,service}.ts`、`bootstrap/features.ts` |
| Skill 说明 | `skills/project_manage/SKILL.md` |

## 验收

隔离栈（独立数据目录、独立端口的 backend 与 worktree 里的 dev web）真机结果，2026-11-25：

- 20 个路由逐页加载：没有错误页，浏览器控制台没有报错，1440、1024、768、390 四档都没有横向溢出。其中已迁到原型设计的 9 个页面在中文和英文下各看了一遍。
- 主题生效后的页面底色 `rgb(16,18,20)`、正文色 `rgb(239,241,238)`、正文 14px。
- 导航按原型分组：Work、最近的会话、Team & Projects、Capabilities、System；Authority 与 Channels 有入口。
- 会话密度：聊天页正文 12px、头像 34px；编辑侧栏里的同一会话正文 11px、头像 30px、人的气泡带薄荷色、发送键 32px。
- 已读规则（在页面脚本运行前挂上请求记录来测）：打开聊天页会调 `/attention/seen`；在同一会话上打开项目编辑侧栏，6 秒内没有任何 seen 调用。
- 关闭项目编辑侧栏后焦点回到打开它的那个按钮上。
- 项目编辑是宽侧栏，左表单右 PA 会话；768 以下切成「表单 / PA 会话」两个标签。
- 有未保存修改时按 Escape、点关闭都先问；选「继续编辑」草稿保留，选「放弃并离开」后项目未被改动。表单干净时 Escape 直接关闭。
- 真实 PA 流程跑了五次，最后一次在项目编辑改用共享 PA 会话之后：`/project_manage` 请求发出后 16–26 秒出现建议卡，逐字段标出「变了 / 没变」；「填入表单」只改表单，服务端项目不变；建议到达后改过表单，卡变过期且不能填入；「放弃建议」后行记录为 discarded（隔离栈数据库里两条都是 discarded），表单里已填入的值保留但不保存；有未保存修改时关闭会先问，「继续编辑」保留草稿，「放弃并离开」不写任何东西，关闭后焦点回到打开它的按钮。保存路径（采用人审阅过的值，行记录为 adopted）在前四次里验证过。
- 成员页的三个地址 `/team/<id>`、`/team/<id>/edit`、`/team/new/edit` 直接打开时分别打开详情与编辑侧栏。

单元测试：web 356 条通过（其中词典一致性 3 条），后端 `proposal` 与 `product-tools` 目录 151 条通过。

没有在真机上验证的：成员编辑侧栏和需求侧栏里的真实 PA 建议流程（只验证了项目编辑的那一条）；没有数据的页面状态以外的内容状态，比如有多个成员、多个需求时的列表。

## 当前进度

| 页面 | 状态 |
|---|---|
| 对话页、项目列表与编辑、成员列表/详情/编辑、需求列表与目标页、建议收件箱、Wiki 索引与阅读页、可观测、渠道 | 已按原型重做，真机验证过 |
| Authority、Settings、成果空间、Workflow、Coding、Skills、MCP、Today、会话列表 | 还是原来的设计，能在新主题下正常显示；纯逻辑层已写好并带测试（Authority、Settings、成果空间、Workflow 的基础模块、Skills 与 MCP 的数据层） |

## 没有解决的

- 项目更新没有版本冲突检测：后端不看 `updatedAt`，并发修改靠后写覆盖。前端过期判定只管同一个表单。
- agent 与 workflow 编辑页的自动采纳要随各自的迁移改成 D3 的形态。
- 新项目只能凭「到达时间」认领提议，因为 `project_creation` 的目标名由 PA 起。
- 管理对话和日常对话共用一段会话（D6）。
- Lark 渠道、Bot 账户、部署与连接状态没有可读模型，`lark-cli init` 这个命令不存在（实际是 `config init`）。Channels 页面的「部署」一栏只能如实显示未提供。
- **现有的 MCP 页面有一个会丢数据的缺陷，要随它的重做一起去掉**：编辑连接时表单里预填的是打码后的密钥，直接保存会把打码值写回覆盖真实值。同一页还有保存失败被当成成功、调用工具出错显示成绿色两处。
- 工作流编辑页仍然自动加载建议，并调用一个必然失败的「采纳」接口（后端对这一类提议拒绝在收件箱采纳），失败时没有任何提示。
- `ops/surfaces` 不会让停掉的 bot 过期：可观测页在客户端按 95 秒心跳判为断开，服务端的过期判定更干净。
- `conversation.projectId` 和需求工作区如何并存、Coding 从运行定位工作台的参数名，等产品决定。
