# ADR 0043: 本地向量能力抽成包：引擎共享，策略各自拥有

> 来源：路线图「知识库只有文件级」一条的排查。结论与最初的设想相反——**要建的东西早就存在**，缺的是它的边界。

## 状态

Proposed（2026-10-13）。决策已由维护者拍定（抽包复用）。**第一步（纯搬迁）已落地**：`packages/embedding` 已建（`private: true`，已在 AGENTS.md 依赖图点名、根 tsconfig 已引用），oma 改为从它取引擎，模型缓存根按决策 1 注入到 oma 侧（`vector-memory.ts` 的 `embeddingCacheDir()`）；搬过去的两个测试文件里混着的「oma 门面」用例已拆回 oma（`vector-memory.test.ts`）。搬迁过程中编译器抓出一处真缺陷：`RetainInput` 少了 `validUntil`（存储持久化它、`vector-recall` 也按它过滤，唯独类型没声明），已补上。**决策 2（两条入口）也已落地**：`@chengchenccc/embedding` 是零原生依赖的核心（契约 + 存储 + 召回，含测试用的哈希 provider），`@chengchenccc/embedding/fastembed` 才带 ONNX 与模型下载；边界由**打包级测试**钉住——核心入口用 `Bun.build` 打出来的产物不含 `fastembed`，而原生入口的含（免得否定断言空过）。**第二步（后端接入）未开工**，且仍受决策 5 约束。

## 上下文

**向量能力已经存在，且只存在于 oma。**`apps/oh-my-agent/src/core/memory/` 下有完整的一套：`embeddings.ts`（本地 fastembed，ONNX，无需 API key；e5 的 query/passage 前缀；模型预置走 HF/mirror、原子落盘、断点续传、跨进程锁）、`vector-store.ts`（向量 + FTS 混合，含 CJK 感知的 `ftsMatchExpression`）、`vector-recall.ts`（召回），外加 `recall` / `retain` 两个工具。

**产品侧没有 embedding 通道。**`@chengchenccc/ai` 里没有任何 embedding 接口（grep 零命中）；`apps/backend` 的会话检索是词法扫描（`searchLedger` 是普通 select，`conversation/` 那层一次都没用 FTS5）；产品摘要**没有生产者**（`appendSummary` 无调用方，`/compact` 与 `/clear` 是显式空操作）。

**对称性差在缝上。**知识包是后端的 MCP server（`knowledge_search` = 关键词 AND + 返回命中行），经 workspace 的 `.mcp.json` 注入，因此**任何挂 MCP 的 harness 都拿得到**；而 oma 的向量栈长在 oma 进程里，**只有 oma 用得上**——harness 是按 agent 选的，同一份知识在不同 agent 上的行为会不一致。

**依赖面（实测）。**`vector-store.ts` 只依赖 `bun:sqlite`；`vector-recall.ts` 只依赖 provider 的类型；`embeddings.ts` 与 oma 唯一的耦合是 **`agentDir`**（模型缓存根）。

**打包代价（实测）。**`scripts/pack-gateway.sh` 用 `bun build --target=bun` 把后端打成**单文件**（脚本自述 “one platform-independent file”，不 ship node_modules）。而 `onnxruntime-node@1.21.0` 是 **208 MB** 的按平台原生二进制，已缓存的模型 `~/.oma/models` 是 **129 MB**。

## 决策

1. **把引擎抽成工作区包 `@chengchenccc/embedding`**（`private: true`，按仓库规则在 AGENTS.md 的依赖图里点名）：`vector-store` 与 `vector-recall` 原样搬入；`embeddings` 的模型缓存根改为**注入参数**（oma 传 `agentDir(...)`，其他消费者传自己的目录）。
2. **两条入口，胖依赖由消费者选着承担。**`@chengchenccc/embedding`（核心：存储 + 打分 + FTS/CJK 助手，无原生依赖）与 `@chengchenccc/embedding/fastembed`（本地 ONNX provider）。**只有显式 import 第二个入口的消费者才吃下 208 MB 与模型下载**。这条是为打包器写的：`bun build` 会内联静态 import，光靠动态 import 挡不住。
3. **一个索引一个向量空间。**索引随记录 **model id** 落盘；查询侧模型不一致时**大声失败**，不静默返回乱序结果。
4. **oma 保留产品语义。**`autonomous-memory`（run 后抽事实）、`learn`、`managed-skills`、`vector-tools` 留在 oma——它们带着 run 上下文与工具面；换掉的只是引擎。
5. **本决策内，后端不引入 embedding。**那会同时失去「单文件」与「平台无关」两条打包性质（208 MB 原生按平台分发 + 129 MB 模型），而知识包的语义检索并不是当前瓶颈。它的解锁条件写在这里：要么出现 provider 级的 embedding 通道（要 key 与计费），要么接受按平台分发与体积。两者都是一次**单独的**决定。
6. **后端对话侧的两处真缺口与向量无关。**先把 `searchLedger` 升级到 FTS5（顺带可复用包里的 CJK/FTS 助手，不必两套实现），再给摘要/压缩补生产者。**不要**用向量去补这两处。

## 后果

- 抽包成功后 oma 的 memory 行为**不变**（纯搬迁），全量测试通过是这一步的验收条件；后端将来要用，路径是「显式 import fastembed 入口 + 接受打包代价」，且由第 5 条单独决定。
- 包的公开面必须为多个消费者造型，不能塞 oma 语义（例如「run 后记忆」不属于包）。
- 未决：`fastembed` 与模型文件的分发方式（运行时预置 vs 打进产物）；本机**只测了磁盘占用，没测常驻内存**。

## 不做的

- 不新增 provider 级 embedding API（无需求）。
- 不对全量会话 ledger 建向量索引（语料规模与收益不成比例）。
- 不把 `autonomous-memory` 的抽取逻辑搬进包（那是产品语义，不是引擎）。
