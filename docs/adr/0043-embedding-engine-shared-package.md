# ADR 0043: 本地向量能力抽成包：引擎共享，策略各自拥有

> 来源：路线图「知识库只有文件级」一条的排查。结论与最初的设想相反——**要建的东西早就存在**，缺的是它的边界。

## 状态

Proposed（2026-10-13）。决策已由维护者拍定（抽包复用）。**第一步（纯搬迁）已落地**：`packages/embedding` 已建（`private: true`，已在 AGENTS.md 依赖图点名、根 tsconfig 已引用），oma 改为从它取引擎，模型缓存根按决策 1 注入到 oma 侧（`vector-memory.ts` 的 `embeddingCacheDir()`）；搬过去的两个测试文件里混着的「oma 门面」用例已拆回 oma（`vector-memory.test.ts`）。搬迁过程中编译器抓出一处真缺陷：`RetainInput` 少了 `validUntil`（存储持久化它、`vector-recall` 也按它过滤，唯独类型没声明），已补上。**决策 2（两条入口）也已落地**：`@chengchenccc/embedding` 是零原生依赖的核心（契约 + 存储 + 召回，含测试用的哈希 provider），`@chengchenccc/embedding/fastembed` 才带 ONNX 与模型下载；边界由**打包级测试**钉住——核心入口用 `Bun.build` 打出来的产物不含 `fastembed`，而原生入口的含（免得否定断言空过）。**决策 7（后端语义检索走 provider-API，不走按平台打包）也已拍定**（决定 5 的两条解锁条件里选了「provider 级通道」那条）；后端摘要/压缩的生产者已落地（`/compact` → `BACKEND_SUMMARY_MODEL`，后端第一条模型调用通路，也是决定 7 的加速器）。**后端语义检索本体仍未开工。**

## 上下文

**向量能力已经存在，且只存在于 oma。**`apps/oh-my-agent/src/core/memory/` 下有完整的一套：`embeddings.ts`（本地 fastembed，ONNX，无需 API key；e5 的 query/passage 前缀；模型预置走 HF/mirror、原子落盘、断点续传、跨进程锁）、`vector-store.ts`（向量 + FTS 混合，含 CJK 感知的 `ftsMatchExpression`）、`vector-recall.ts`（召回），外加 `recall` / `retain` 两个工具。

**产品侧没有 embedding 通道，但已有模型调用通路。**`@chengchenccc/ai` 里没有任何 embedding 接口（grep 零命中）；`apps/backend` 的会话检索是词法扫描（`searchLedger` 是普通 select，`conversation/` 那层一次都没用 FTS5）；产品摘要**已有生产者**（2026-10-13：`/compact` 按 `BACKEND_SUMMARY_MODEL` 调模型，这是后端第一条模型调用通路，也是决定 7 的加速器）。

**对称性差在缝上。**知识包是后端的 MCP server（`knowledge_search` = 关键词 AND + 返回命中行），经 workspace 的 `.mcp.json` 注入，因此**任何挂 MCP 的 harness 都拿得到**；而 oma 的向量栈长在 oma 进程里，**只有 oma 用得上**——harness 是按 agent 选的，同一份知识在不同 agent 上的行为会不一致。

**依赖面（实测）。**`vector-store.ts` 只依赖 `bun:sqlite`；`vector-recall.ts` 只依赖 provider 的类型；`embeddings.ts` 与 oma 唯一的耦合是 **`agentDir`**（模型缓存根）。

**打包代价（实测）。**`scripts/pack-gateway.sh` 用 `bun build --target=bun` 把后端打成**单文件**（脚本自述 “one platform-independent file”，不 ship node_modules）。而 `onnxruntime-node@1.21.0` 是 **208 MB** 的按平台原生二进制，已缓存的模型 `~/.oma/models` 是 **129 MB**。

## 决策

1. **把引擎抽成工作区包 `@chengchenccc/embedding`**（`private: true`，按仓库规则在 AGENTS.md 的依赖图里点名）：`vector-store` 与 `vector-recall` 原样搬入；`embeddings` 的模型缓存根改为**注入参数**（oma 传 `agentDir(...)`，其他消费者传自己的目录）。
2. **两条入口，胖依赖由消费者选着承担。**`@chengchenccc/embedding`（核心：存储 + 打分 + FTS/CJK 助手，无原生依赖）与 `@chengchenccc/embedding/fastembed`（本地 ONNX provider）。**只有显式 import 第二个入口的消费者才吃下 208 MB 与模型下载**。这条是为打包器写的：`bun build` 会内联静态 import，光靠动态 import 挡不住。
3. **一个索引一个向量空间。**索引随记录 **model id** 落盘；查询侧模型不一致时**大声失败**，不静默返回乱序结果。
4. **oma 保留产品语义。**`autonomous-memory`（run 后抽事实）、`learn`、`managed-skills`、`vector-tools` 留在 oma——它们带着 run 上下文与工具面；换掉的只是引擎。
5. **本决策内，后端不引入 embedding。**那会同时失去「单文件」与「平台无关」两条打包性质（208 MB 原生按平台分发 + 129 MB 模型），而知识包的语义检索并不是当前瓶颈。它的解锁条件写在这里：要么出现 provider 级的 embedding 通道（要 key 与计费），要么接受按平台分发与体积。两者都是一次**单独的**决定。
6. **后端对话侧的两处真缺口与向量无关。**`searchLedger` 已从「整串 LIKE」改成「**每个词都必须命中**」的分词扫描，复用包里的 CJK/ASCII 分词器（`needleSegments`，来自零原生依赖的核心入口）。FTS5 曾是要做的，实测推翻了它：账本 1.9k 行 / 4.1MB 时，两词扫描约 **7ms** —— 现阶段建 FTS 索引只是一次迁移、一组触发器和一份 snapshot 记账，换不来任何东西；语料涨到约 10 倍时再评估。摘要/压缩的生产者**已实现**（2026-10-13，后端第一条模型调用通路）；两件事都**不要**用向量去补。
7. **后端要语义检索时，走 provider-API embedding，不走按平台打包（2026-10-13 拍定，即决定 5 的第一条解锁条件）。**理由三条，前两条有数字：① **加速器是现成的**——后端刚有了模型调用通路，而目录里绝大多数 provider 是 OpenAI 兼容的，加一个 `embed()`（`POST /embeddings`）是**一个 provider 方法**的量级；② 反向选项的代价本轮实测过：**208 MB** 原生**按平台** + **129 MB** 模型，而 `pack-gateway.sh` 打的正是单文件、平台无关产物 ⇒ 引入它同时失去两条打包性质；③ **降级是优雅的**——没有 key 或离线时语义检索不可用，而词法检索仍在（就是今天的行为），不是全有或全无。边界：只在后端需要处使用（知识包检索），`knowledge_search` 仍是跨 harness 的 MCP 工具；索引与向量空间沿用决定 3（记录 model id、不匹配就大声失败）；**不**对全量 ledger 建向量索引（决定 6 的语料结论不变）；provider 不提供 embedding 端点时该 provider 下语义检索直接不可用，**不做**本地回退——回退就是词法。再评估门槛：provider-API 的**成本与配额**实测之后，再决定是否给知识包做后台批量嵌入。
   **2026-10-13 实测（门槛的答案）**：这台机器**当前没有可用的 embedding 通道** ✗ —— deepseek 只有 chat 端点（无 embeddings）✓；智谱的 key 在 `open.bigmodel.cn/api/paas/v4/embeddings`、`api.z.ai/api/paas/v4/embeddings`、`api.z.ai/api/coding/paas/v4/embeddings` 三个端点上一律返回 **429 `code 1113 余额不足或无可用资源包`** ✓。⇒ **本体先不做**（做了也只是本机跑不起来的投机实现 ✗）。**复活条件**：出现一个**能用的** embedding key（或现有 key 充值到可用 ✓），此时第一步就是把 `embed()` 缝、整页向量索引与「无 key 退回词法」一起做掉（v1 不做 chunker，整页一个向量，chunk 级留作下一步）。

## 后果

- 抽包成功后 oma 的 memory 行为**不变**（纯搬迁），全量测试通过是这一步的验收条件；后端要语义检索的路线已由**决定 7** 拍定（provider-API），按平台分发那条**不采用**。
- 包的公开面必须为多个消费者造型，不能塞 oma 语义（例如「run 后记忆」不属于包）。
- 未决：`fastembed` 与模型文件的分发方式（运行时预置 vs 打进产物）；本机**只测了磁盘占用，没测常驻内存**。

## 不做的

- 不做按平台分发的本地 embedding（决定 7 已给出取舍：208 MB × 平台 + 129 MB 模型，换掉单文件与平台无关两条性质）。
- 不对全量会话 ledger 建向量索引（语料规模与收益不成比例）。
- 不把 `autonomous-memory` 的抽取逻辑搬进包（那是产品语义，不是引擎）。
