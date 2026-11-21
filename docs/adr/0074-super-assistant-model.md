# ADR 0074: 超级助理模型 —— 会话按团队成员找人，事项按目标追事，知识按主题沉淀

- 状态: Accepted（设计定稿；S0 导航分层与词汇已实现，事项/Wiki 分阶段）
- 日期: 2026-11-20
- 相关: ADR 0049（前台不变量）、0059（双工回传）、0060（验收与署名）、0061（注意力轴）、0065（记忆生产者）、0070（派发即子会话）、0072（前台不干活）
- 素材: 用户提供的《Super Agent 产品与系统设计稿》+ 本仓库实现对照

## 背景

产品语言从"前台/工人"升级为**超级助理（PA）/ 团队**。PA 是 personal agent：管人的注意力（理解、拆解、派发、协调、交付），并作为 second brain 把长对话沉淀为 LLM wiki（参考 Karpathy 的 LLM Wiki 与 second-brain-skill：raw 只读 / wiki 由 LLM 写 / schema 约定；ingest / query / lint）。

## 一、与既有实现的对照（防漂移：哪些是已建的，哪些是新的）

| 设计稿主张 | 仓库现状 | 判定 |
|---|---|---|
| Run 一次执行尝试，返工=新 run；终态只提交一次 | ADR 0060 D2，已实现 | 已建 |
| steer 快速路径 + 持久结果输入；事件去重与消费确认 | ADR 0059 双轨 + `result_notified_at` | 已建 |
| 署名由渲染层保证 | ADR 0060 D3 + `authorAgentId` | 已建 |
| 授权执行前冻结 | ADR 0047 + 0072 | 已建（更严） |
| Worker 独立会话/上下文/workspace | ADR 0070 子会话 | 已建 |
| 会话复用策略 | ADR 0070 D2（按 (父,工人) 复用，可配置） | 已建 |
| 人工直接对 Worker 发话=显式+通知 | ADR 0066 D4（下车间） | 已建 |
| 自动链上限 | `MAX_WAKE_DEPTH=3` | 已建 |
| Request 收件箱 | ADR 0061 `pending_action` + 注意力轴 | 部分（缺稳定 ID、reopen） |
| 验收证据 | PR #112 verification 四态（run 级） | 部分（非事项级） |
| **Requirement（事项）** | 无 | **新实体** |
| **Wiki** | 无（有 knowledge packs 只读、`.oma/memory`、`product.md`） | **新实体** |

## 二、锁定的产品决策（用户拍板，2026-11-20）

1. **人配置团队，助理负责调度**：超级助理从池中选人、派单、跟进；发现能力缺口提**建议**，由人批准创建；不得自建成员，不得借配置提案扩权。"管理"是调度，不是招聘。
2. **Raw 双入口，后端保存**：(a) 对话区间（引用账本区间，不复制整段聊天）；(b) 人主动提供的文件/链接/转发（后端接收、抓取、解析，记来源/时间/范围/是否已整理）。**助理不直接写 raw**；保存材料≠认可内容；"明确收录"由人触发。
3. **事项是跨会话的工作锚**：换 PA 会话后按事项恢复（目标/约束/状态/活跃执行/未决 Request/最新交付/历史会话摘要/相关 wiki）；实时状态读后端事实，历史摘要只帮理解；**不共享模型上下文**。多候选事项时展示候选；控制动作（取消/授权/验收）不猜归属。
4. **删除现场与删除知识分开**：删会话不级联删事项（修订 ADR 0070 D5 的事项部分）；三操作=归档会话（隐藏但引用可及）/删除会话（事项保留，引用标"来源已删除"）/删除事项（单独明确操作）。删会话前必须处理活跃 run（v1：先停止）；已沉淀的 wiki 不随聊天自动删除，界面必须说明并提供检查/清除入口；隐私清除不得留下知识副本或可"复活"原文的摘要。
5. **产品词汇**：PA=**超级助理**（技术标识 `pa`）；worker=**团队成员**（导航分组叫"团队"）；requirement=**事项**（列表"事项"，详情"事项目标/验收标准"）；Request=**决策请求**（不叫事项）。存储枚举 `worker` 保留不动，词汇换产品层。

## 三、PA 的权限模型（修订 ADR 0072 的表述）

> PA 禁止通用业务执行；保留协调产品工具。PA 仅通过后端受控 Wiki 工具修改知识正文，不拥有任意文件写入、命令执行或权限配置能力。

- **协调**：读自己的会话/事项/团队状态；dispatch / steer / cancel（受授权约束）；创建决策请求；向人解释与交付。
- **知识维护**：读获准的 raw/wiki；经专用工具写 wiki 正文。
- **禁止**：写 worker workspace、写代码/配置/产品数据、任意 bash/eval、部署与数据库等业务工具。

**Wiki 工具是产品工具**（`wiki_read / wiki_patch / wiki_create / wiki_query / wiki_lint / wiki_commit`），不是原生文件工具：
- PA 只传**相对页面名**与修改内容；后端定 wiki 根、防路径穿越与符号链接逃逸；
- 写入带 `expected_revision`/fingerprint，不覆盖人的修改；
- 禁改 `.git`、hooks、运行配置、授权文件；
- commit 与结构检查由后端执行，记录来源/diff/结果。

**v1 不设图书馆员**：PA 经上述工具直接做轻量增量整理；批量 ingest/深度 lint 以后再委派。自动整理限预算、可暂停、不延迟人的消息。**不为 wiki 重新开放 bash/eval。**

**边界的一般形式（2026-11-21 真机教训）**：前台的判据不是"哪类活"清单，而是**答案的来源**——能从本段对话里满足的是 ANSWER，需要对话之外任何东西（文件、仓库、网页、账号、服务、产出物）的是 WORK。工具层把这条判据变成事实：前台**没有** `read/ls/grep/glob/tree/web_*/browser`（连同 bash/eval/write/edit），它自己的工作区也没有代码。于是"我去看看"这句话在物理上不成立，只剩派发或补一个缺失细节（如"项目在哪"）两个出口。**派出去撞墙不算解决**：worker 报告无访问时，前台开一条决策请求写清要授权什么，或换人——绝不回退成"那我自己来"。

**Wiki 可写 ≠ 权限规则可写**：agent 配置、工具白名单、沙箱策略、授权快照、系统指令、受信 schema、git hooks、worker 配置与 workspace 全部在写范围之外。wiki 里写"允许合并"不构成授权——**wiki 是知识输入，不是控制平面**。

## 四、Wiki 的结构与权威

- 全局一份，项目分区：`wiki/{index.md, personal/, projects/, decisions/, concepts/, lessons/}`；会话不是知识隔离单位。
- **分区不自动等于权限**：`personal/` 永不进 brief 的约束在**召回出口与 brief 构建层**执行，不只是目录约定；防跨分区间接泄露（v1 限制跨分区编译，或显式标记共享范围）。
- **来源权威按事实类型，不按谁说**：用户意图/偏好/授权→人的明确表达；测试是否通过→对应检查证据；外部资料说了什么→原始材料；相互矛盾的解释→保留冲突，不自动裁决。人在 recall 排序中只对自己的决定最高。
- 写契约走 **git**：wiki 目录为 git 仓库；自动整理=带来源引用的 commit；人的手改=手动 commit，永不被自动重编译覆盖；"被替代"=页面前言 `supersedes:` 链 + lint 检查。
- 三操作：ingest（增量整理）/ query（先编译知识，必要时回查 raw）/ lint（矛盾、孤儿页、过时、缺引用）。wiki 不保证无损记忆，重要结论可回查来源。

## 五、事项（Requirement）：PA 识别并持续维护的工作目标

**事项不是派单 Brief 的副本**（2026-11-20 完整形态稿修正）：它由 PA 从对话中识别、总结和持续维护——
- **可以先讨论、不执行**：一个事项可以零派单存在，也可以多次派单、跨成员协作、返工；
- **PA 的归纳与用户的明确表达要区分**：用户可纠正、合并、拆分；
- **状态依据来自执行、待决与验收记录**，不由 PA 改一句摘要就宣布完成。

实现上仍走懒路径（避免新造大实体）：
- 表 `requirement`（id、目标/背景/约束/预期交付/验收标准、origin 消息引用、PA 归纳与用户原话分开存）；
- `agent_run.requirement_id`（dispatch 工具写入，派单必须关联一个事项）；
- 详情页按 `requirement_id` join runs/dispatches/artifacts/requests，**不复制聊天**。
- **创建边界**：PA 经产品工具（`requirement_track` 一类）创建"值得跟进的目标"；纯问答永不建。派活必关联事项，但事项不必有派单。
- 状态是派生视图：有活跃 run→进行中；有阻塞决策请求→待你处理；终态+验证过→待验收；人验收（一次决策请求）→已完成。并行时主状态+事实计数。

## 五b、Web 的五个视角

> 会话找人，需求追事，Project 找文件，Knowledge 配资料，Wiki 找知识。

| 视角 | 组织方式 | 备注 |
|---|---|---|
| 会话 | 按成员（超级助理 + 团队分组成员） | 导航按 Worker 组织，不按需求；人工进 Worker 现场=显式接管（ADR 0066 D4），留痕并同步 PA |
| 需求 | 按目标 | §五 |
| Projects | 按项目目录（Git 现场与改动） | **不是需求容器**：需求↔项目多对多，也可完全不涉及 |
| Knowledge | 预配置知识/能力文件包 | 人配置启用；**PA 的 wiki 写权不包含修改 Knowledge 包** |
| Wiki | 按主题分区（全局一份逻辑知识空间） | §四 |

实现约束：web 源码的 CJK 仍被 `audit:ui` 门禁（i18n 未落地），故界面用英文标签（如 Team），中文词汇（超级助理/团队成员/事项）先落在文档与提示词层。

## 六、决策请求（Request）的升级（S2，已落地）

- 已有：`pending_action`（ask/approval）、会话+时机匹配、五条打扰纪律。
- **卡片答案携带 request_id**：已核实两端本就成立——Web 的 `resolveProductAsk` 带 `runId+callId`，Lark 卡片 action value 带 `runId+callId+questionId`；S2 只补钉：**第二个表面再答**不会覆盖第一个答案（活体 resolver 已消费 + 持久 CAS 拒绝，`resolveAsk` 返回 false）。
- **reopen**：同一 run 里再次 `ask_question` 时，持久 payload 带 `reopens: <上一次 ask 的 actionId>`——记录读作"同一决定的追问"，不是无历史的新问题。这是确定性判定（同一 run = 同一决策链），不猜文本。
- **Lark/Web 同一份**：两端都落同一 `pending_action` 行，任一端回答后另一端的视图从同一行读状态。
- 自由文本回复仍靠匹配——**如实保留该缺口**，新增 `text_answer_orphan` 观测（无 pending ask 但 10 分钟内该会话刚答过 ask ⇒ 记为可能的错配），与 `unasked_question` 一起构成错配率的两个读数；观测不改变行为。

## 六b、Wiki（S3，已落地）

**位置**：`<dataDir>/wiki`，独立于任何 agent 的工作区（产品级资产：换 PA、删 agent 不带走知识），本身是 **git 仓库**。

**目录（Karpathy LLM-wiki 形状 + 我们的分区）**：

```
wiki/
  schema.md      ← 运营约定（第三层：人机共演化，读得到才守得住）
  index.md       ← 每次写入自动重建的目录
  log.md         ← 只追加，`## [时间] 动作 | 路径 — 作者`
  raw/
    conversations/  ← 对话区间「引用」（记 seq 范围，绝不复制聊天）
    files/          ← 人提供的材料，原样保存
  personal/<agentId>/   ← 私人区：只有该 PA 可写
  projects/<project>/   ← 公共区：任何 PA 可写
  decisions/ concepts/ lessons/
```

**写权限**：`maintainedBy` 记归属（patch 永不翻转）；`personal/` 的写者由**路径约定**强制（第二段必须等于调用者 agentId）——可审计的规则，不是隐藏策略。公共分区任何 PA 可写。

**工具集（唯一写路径，仍是产品工具，PA 不获得 file/命令能力）**：
`wiki_read` / `wiki_query`（标题+正文子串，先查编译知识）/ `wiki_create` / `wiki_patch`（**`expected_revision` CAS**，过期拒绝并回当前页）/ `wiki_lint`（无来源、孤儿页、supersedes 指向不存在）/ `wiki_source_add`（对话区间按引用 / 文本原样入库）。

**并发**：按页串行（进程内队列）+ CAS。两个 run 或两个 PA 同时改一页：先到的赢，后到的被拒并看到当前页——要求重读合并，不静默覆盖。**多后端实例不在部署模型内**（单 SQLite 本就单写者）。

**HTTP 只读**：`/api/wiki/pages|page|query|lint`；写入必须经工具或人通过 git——不开第二个未经审计的写入口。

**Wikipedia 类比**：借鉴的是**可验证性**（sources + lint）与**历史**（git、作者）；不搬开放编辑、关注度门槛与「禁止原创研究」——PA 的综合正是产品价值。人的手改=普通 commit，自动整理不覆盖；矛盾由 lint 列出交人裁决，不自动合并。

**不做**：实时运行状态（后端事实）、权限配置（wiki≠控制面）、Knowledge 包（独立配置）、嵌入检索（index.md 在这个规模足够）。

### lint 的触发（真实环境的答案）

| 层 | 时机 | 谁消费 | 状态 |
|---|---|---|---|
| 写入时（inline） | `wiki_create` / `wiki_patch` 的**返回值里带这页自己的 findings**（无来源、孤儿、悬空 supersedes） | 写入者（助理）——同一轮就能补 | ✅ 已做，与全量 sweep 共用同一个谓词 |
| 打开时（pull） | 人打开 `/wiki`，健康检查面板实时计算 | 人 | ✅ 已有 |
| 定时巡检 | 每日一次全库 lint → 落 ops 事件；**不进注意力收件箱**（只有决策请求打扰人）；助理在空闲窗口自行处理 | 助理 | ❌ 未做：挂在现有 cron/workflow 调度上即可，等真实出现「长期不整理的库」再上 |

**为什么第一层最重要**：lint 的价值在于「写的时候就别写错」。一个刚写下的无来源结论，作者就在现场、成本最低；等到每日巡检再发现，改的人已经不在上下文里了——那正是知识库腐烂的方式。

### 定时巡检（已做，2026-11-20）

种子写 `workflows/wiki-lint.workflow.json`（每日 04:00，`0 4 * * *`）：
- 一个 **agent 节点**，跑 Personal Agent 的 lint 纪律——无来源补来源或降 draft、孤儿补回链、悬空 supersedes 删条目、过时只标记不裁决、同一概念被三页以上链接才建 stub；
- **无人审节点**：lint 是维护，不是决策，注意力收件箱只留给人必须拍板的事；
- 每处修改走 `wiki_read` → `wiki_patch(expected_revision)`，被拒就重读重合并；
- 真机验证（2026-11-20 手动触发 execution `de11bf95…`）：它给 `concepts/super-agent-conventions.md` 末尾加了「相关页面 → `[[PA permission model]]`」，orphan 消失，`/api/wiki/lint` 归零。

### 种子的身份与成员（同日）

- 种子 = **Personal Agent + Coder + Researcher**（两个 worker 的能力卡不同，选人才有得选）；
- 每个种子成员写**角色化 SOUL.md**（人员设定，不是产品规则——产品规则是前台纪律，重复写会彼此过期）；
- 只写模板/空文件：`identityTextOf` 判定「还是模板」才覆盖，人写过的一个字都不动；
- `.agent-seed.json` 标记已种成员：**删掉的成员不会每次重启又长回来**（guide agent 的教训）。

## 六b2、派单消息的形状与需求的归属（2026-11-21）

**worker 收到的第一条消息是 XML 结构**（项目里 goals 提示词已在用的写法）：`<dispatch>` → `<task verb/deliverable/object-kind/object>` → `<slots>` → `<references>`（继承的出处）→ `<front_findings>`（**前台自己查到的**，如命中的 wiki 页标题+路径）→ `<meta conversation/parent-run/to-agent>` → `<note>` → `<original_request>`（原文逐字，最后收尾）。

为什么分 `<references>` 与 `<front_findings>`：前者是转交的出处，后者是前台的**解读**。混在一起，解读就会被当成证据。

**需求归属项目**：`requirement.project_id`（迁移 0065）。前台用 `project_list` 看有哪些项目，`requirement_track(project=名称或 id)` 归档；两个项目都像时，这正好是值得问的那一个细节；一个都不像就明说，而不是编一个位置。

**前台先查已知**：回答或发问之前，先 `wiki_query` / `requirement_query` / `project_list`——已经写下来的答案不该再花人的注意力问一遍。

## 六c、派单接 wiki（S4，已落地）

派单时（`dispatch` 工具）用 `verb + object + instruction` 查询 wiki，命中的前 3 页以 `wiki:<path>` 形式并入 brief 的 `references`——与账本/记忆召回同一种证据，只给路径，工人自己翻页。wiki 为空或未配置时零成本跳过（`wikiRecall` 缺省即无 wiki 部署）。

**未做（记录在案）**：需求详情页的「使用了哪些 wiki 页」没有单独落库——brief 的 references 只存在于派单输入里。要做需要给需求加一张关联表，等真实使用出现需求再加，不提前建。

## 六d、Wiki 阅读体验：借 Obsidian 的语义，不借它的编辑器（S5）

| Obsidian 效果 | 我们做了 | 为什么 / 何时再上 |
|---|---|---|
| 文件树侧栏 | ✅ 空间→目录→页面的树（`/wiki` 左栏） | 当前规模几十页；上限约 1k 页，超过再引入虚拟化树 |
| `[[wikilink]]` / `[[path\|label]]` | ✅ 按标题或路径解析；**未解析的链去搜索页**，不去 404（只读 wiki 里「新建页」是助理的活） | 字符串变换而非 remark 插件：输出仍是普通 markdown，渲染只有一条路径、一套 sanitize |
| `![[embed]]` | ✅ 渲染为「打开该页」的链（不做转写） | 复制内容会与源页漂移 |
| 双链反链 | ✅ `/api/wiki/backlinks`：`[[Title]]` 与 `](path)` **两种语法都算**，lint 的 orphan 判定同源 | 一个图，不因写法不同而断 |
| 全文搜索 | ✅ **并进 Ctrl+K**（全局命令面板），wiki 页不再自带搜索框 | 产品里只留一个搜索入口；CJK 分词是坑，等规模与真实需求再换（MiniSearch/Intl.Segmenter） |
| 代码高亮 | ❌ | 页面以散文为主；加 shiki 是为观感付 1MB 依赖，等真实代码页出现 |
| 关系图谱 | ✅ Files / Graph 双视图：`/api/wiki/graph` 返回节点+边，前端 d3-force **同步 tick 后渲染静态 SVG**（无动画循环、确定性起点=圆周分布） | 边只连**存在**的页面（未解析的链不画没人能点的节点）；规模上限约几百节点，超过再考虑 canvas/WebGL 与缩放 |
| 实时保存 / CodeMirror 编辑 | ❌ | 与「wiki 只读、写经工具或 git」冲突；人的编辑走 git commit，自动整理不覆盖 |
| 命令面板 Cmd+P | ❌ | 无 cmdk；搜索框已覆盖当下用法，等用户提出 |

**共同原则**：借语义（链接、反链、来源、历史），不借编辑器；每个「未做」都标了触发条件，不是遗忘。

## 七、落地顺序

| 刀 | 内容 |
|---|---|
| S0 | 导航分层（团队成员会话折叠在 PA 会话下一层）+ 全站词汇（本 ADR 已定） |
| S1 | 事项 v1（Brief 持久化 + `requirement_id` + 事项列表/详情页） |
| S2 | 决策请求升级（卡片带 ID、reopen、双端同步） |
| S3 | Wiki（git 仓库、分区、wiki 工具集、ingest/lint；v1 PA 直用工具） |
| S4 | 派单 brief 接 wiki 召回（`wiki:<path>` 进 references） |

暂不引入（同意设计稿）：重型话题栈、通用 DAG 编排、多层 PA、执行认领队列、全量知识图谱。

## 八、验收场景（除既有真机/变异已覆盖外，新增两条为 S1/S3 验收项）

- 用户换 PA 会话续旧事项（S1）；
- 人手改 wiki 与自动 ingest 冲突（S3，git merge 裁决）。
