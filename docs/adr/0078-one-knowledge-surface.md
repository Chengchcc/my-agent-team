# ADR 0078: 知识只有一个面 —— 下线知识包，wiki 即知识

- 状态: Accepted
- 日期: 2026-11-23
- 相关: ADR 0022（知识包/技能包）、0074（超级助理与 wiki）

## 背景

产品里并存两套"知识"：

- **知识包（knowledge pack）**：安装流水线（`source_url` / `version_ref` / `installed_ref`），
  按 agent 挂载，运行前在 `<workspace>/knowledge/` 建符号链接并生成索引；
  带向量检索（embedding）。
- **wiki（ADR 0074 S3）**：PA 维护的 git 版本化知识库（`concepts` / `decisions` /
  `lessons`），每页带来源，`wiki_*` 六个工具，`/wiki` 页面。

两者在**人与 agent 的视角**是同一个问题——"知识在哪"——却给了两个答案。知识包
实际无人维护（库里仅 2 条内置包），而挂载这一步又让"知识能不能被某个 agent 用"
取决于配置，而不是取决于知识本身。

## 决定

1. **知识包整体下线**：特性目录、路由、MCP 挂载、agent 配置字段
   （`knowledge_packs`）、`/team/knowledge` 页面、表 `knowledge_pack`
   （迁移 0068 删除）。
2. **wiki 是唯一的知识面**：读、写、检索都只走 `wiki_*`；需要"从外部导入知识"时，
   导入是把内容写成 wiki 页面（来源写进 frontmatter 的 `sources:`），
   而不是另立一种资源类型。
3. **embedding 客户端保留**（`features/embedding-client.ts`）：记忆检索仍在用它，
   与知识包无关。

## 代价

- 失去知识包的向量检索；wiki 目前是词法检索（索引文件即搜索）。当 wiki 规模
  需要向量时，在 wiki 上加，而不是恢复第二套知识。
- `agent_config` 提案的 payload 里可能仍带 `knowledge_packs`；应用时忽略未知字段
  （`agentUpdateFromConfig` 只映射已知键）。
