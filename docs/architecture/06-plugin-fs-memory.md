# Plugin: FS Memory

文件系统持久化记忆 plugin。把"agent 的长期记忆"做成一个**磁盘目录**——LLM 通过 tool 增量写入事实，每轮 LLM 调用前由 plugin 自动把 MEMORY.md 拼到 system prompt 末尾。

> 这是 [Plugin](./03-plugin.md) 的一个具体实现，**不是新概念**。它走的是 Plugin 的 4 个时机里的 `beforeModel`，配合自带的 tool 集（[Plugin.tools 静态声明](./02-framework.md#plugin)），完全在 framework 现有能力上落地。

---

## 一、为什么需要这个 plugin

agent 跨 session 失忆——每次 `agent.run()` 都从零开始，除非调用方手动拼上下文。三个真实痛点：

1. **用户偏好**：用户告诉 agent "我喜欢简洁回答"，下次新 thread 又得重说
2. **项目背景**：agent 在某个项目里干了几个 turn 学到的事实（架构决策、约定俗成），下次切回这个项目要重头探索
3. **长期事实**：合规要求、客户身份、上一次失败的经验——这些不属于"对话历史"，属于"agent 的世界观"

### 不引入 plugin 的替代方案

| 方案 | 为什么不够 |
|---|---|
| 调用方手动 `messages.unshift({ role: 'system', content: memoryFile })` | 把 plumbing 暴露给每个调用方；多个 harness 各写一遍 |
| 做成纯 tool `memory_read()` 让 LLM 主动调 | bootstrap 信息每轮都要看，让 LLM 每个 turn 主动 call tool 是浪费 token + 浪费一次思考 |
| 塞进 [Checkpointer](./04-checkpointer.md) 的 messages 历史 | checkpointer 存的是会话历史，不是跨会话事实；fork 会复制 = 错误 |

所以 memory plugin 的存在性来自一个第一性事实：**有一类信息每轮 LLM 都要看见，但又不属于会话历史本身**。它必须在 `beforeModel` 注入，且不进 `thread.messages`。

---

## 二、目录结构

```text
${dir}/
├── MEMORY.md              # 长期记忆全文。每轮 beforeModel 拼到 system 末尾
└── facts/
    ├── 2026-06-05-${slug}.md   # LLM 通过 memory_write 追加的离散事实
    └── ...
```

- `MEMORY.md` 是**永远会被注入**的根文件。用户手写起步，也可以由 LLM 长期 self-compact 写入（见 §六）
- `facts/*.md` 是**按需检索**的离散事实。LLM 通过 `memory_search` 找到候选 → 通过 `memory_read` 读全文

**为什么分两层（MEMORY.md vs facts/）**：直接对照 Claude Code 的 `CLAUDE.md` + 长期消息日志的分层做法。`MEMORY.md` 是 hot path（每轮注入），`facts/` 是 cold path（按需检索）。混在一起的话，要么每轮注入太多，要么关键信息查不到。

**为什么没有 `.index.json`**：v1 故意**不维护**派生索引文件。`memory_search` 每次全扫 `facts/*.md` + mtime cache 即可——facts 通常少于几百个 markdown，全扫 < 10ms。不引入 index 的理由是避免**双写一致性**问题（写 fact 时同时改 index，崩在中间就脏了），与 [fileCheckpointer 同款单一真相纪律](./04-checkpointer.md#filecheckpointer) 对齐。当 facts 量级上千需要倒排索引时，再独立引入 embedding 适配包，不会改这个 plugin 接口。

---

## 三、注入策略

每轮 `beforeModel` 收到 `messages`，plugin 找到第一条 system message，把 MEMORY.md 内容**追加到它的 content 末尾**，返回新 messages 数组：

```ts
async beforeModel(ctx, messages) {
  const memoryContent = await readMemoryWithCache();  // mtime cache
  if (!memoryContent) return [...messages];           // 空 memory 直接透传

  const systemIdx = messages.findIndex(m => m.role === 'system');
  if (systemIdx < 0) {
    ctx.logger.warn(
      'fs-memory: no system message found, skipping memory injection. ' +
      'Use createAgent({ systemPrompt }) to enable.'
    );
    return [...messages];
  }

  const sys = messages[systemIdx];
  const newSys = {
    ...sys,
    content: `${sys.content}\n\n<memory>\n${memoryContent}\n</memory>`,
  };
  return [...messages.slice(0, systemIdx), newSys, ...messages.slice(systemIdx + 1)];
}
```

### 为什么拼 system 而不是新建 user 消息

调研主流方案（Claude Code `CLAUDE.md`、Cursor Rules、Cline `.clinerules`、Aider `CONVENTIONS.md`、mem0 默认范式）——**全部拼到 system prompt 末尾**。一致的工程理由：

1. system role 在 LLM API 里是特殊字段，**天然不会被多轮 prune 掉**，是全程可见通道
2. memory bootstrap 的语义是"agent 的背景知识"，不是"用户说的话"，塞 user role 在语义上是错的
3. 避免插队混乱——独立 user 消息插在 system 之后会破坏 user/assistant 节奏
4. 与 [systemPrompt 自动插入](./02-framework.md#agent) 同源——CM 看到的是含 system 的完整 messages，plugin 在同一个 system 末尾追加，机制对齐

### 为什么没有"幂等检查"

每轮注入不进 `thread.messages`——`beforeModel` 返回的是**派生视图**（架构对齐 [ContextManager 的 shape 纯函数纪律](./05-context-manager.md#设计纪律) 在 plugin 上的镜像）。

每轮重新拼接的代价是磁盘读 + 字符串拼接。MEMORY.md 通常 < 10KB，加 mtime cache 后接近零成本。收益是：

- plugin 零跨轮状态——纯派生
- 用户运行时编辑 MEMORY.md，下一轮自动生效
- 实现没有边界情况

---

## 四、Tools

plugin 通过 `Plugin.tools` 静态声明自带的三个 tool（见 [Plugin.tools 字段](./02-framework.md#plugin)）：

| Tool | 入参 | 返回 | 副作用 |
|---|---|---|---|
| `memory_read` | `{ path?: string }` | MEMORY.md 全文 或某个 fact 全文 | 无 |
| `memory_write` | `{ content: string; tags?: string[] }` | `{ path: string }` 写入路径 | 在 `facts/${ts}-${slug}.md` 新增文件（append-only，无 index 双写） |
| `memory_search` | `{ query: string; limit?: number }` | `Array<{ path, title, tags, snippet }>` | 无 |

### memory_search v1：纯 substring + mtime cache

按你的决议（不做 embedding、不做 `.index.json`），v1 实现：

1. **加载**：列举 `facts/*.md`，解析每个 fact 的 frontmatter（`title` / `tags`）+ body；以 `facts/` 目录 mtime 为 cache key（目录 mtime 变 = 增删 fact）
2. **匹配**：对 `query.toLowerCase()` 在每个 fact 上做 substring 检测，不做分词、不做 stem——中文天然支持
3. **打分**：`score = tag_hit * 3 + title_hit * 2 + body_hit * 1`
4. **返回**：取 top `limit ?? 5`，返回每条 fact 的前 200 字 snippet

为什么不分词：avoid 引入 jieba / wink-tokenizer 等依赖；substring 对纯关键词召回足够，且对 CJK / 代码标识符比分词更稳。embedding v2 留 future work——届时引入 `@my-agent-team/embeddings` 适配包，不动 plugin 接口。

### memory_write 流程

```ts
async function memoryWrite({ content, tags }) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = slugify(content.slice(0, 40));
  let filename = `${ts}-${slug}.md`;
  let filepath = path.join(dir, 'facts', filename);

  // 毫秒 ts 仍撞 → 后缀 -2/-3/... 兜底
  let n = 2;
  while (await exists(filepath)) {
    filename = `${ts}-${slug}-${n}.md`;
    filepath = path.join(dir, 'facts', filename);
    n++;
  }

  const frontmatter = `---\nts: ${ts}\ntags: ${JSON.stringify(tags ?? [])}\n---\n`;
  await fs.writeFile(filepath, frontmatter + content);   // 不 fsync
  return { path: filepath };
}
```

**不 fsync、不维护 index**：与 [fileCheckpointer 同款纪律](./04-checkpointer.md#filecheckpointer)——memory 整体是增益不是契约。新 fact 落盘后，下一次 `memory_search` 检测到 `facts/` mtime 变化，自动重扫，无需双写。

---

## 五、与 framework 其他组件的边界

| 组件 | 关系 |
|---|---|
| `ContextManager` | 不重叠。CM 处理"已有 messages 子集化"，fs-memory 处理"system 末尾追加内容"。注入顺序是 `CM.shape() → plugin.beforeModel`（[见 framework](./02-framework.md#agent)），意味着 memory 注入后不会被 CM 截掉——这是有意的，bootstrap 必须可见 |
| `Checkpointer` | memory 注入的内容**不进 thread.messages**（只在 beforeModel 派生），不会被 save。resume / fork 时不会重复带——磁盘上的 MEMORY.md 是 single source of truth |
| `Logger` | plugin 用 `ctx.logger.debug/warn` 输出注入/跳过日志 |
| `InterruptSignal` | `memory_write` 是只读追加，**不需要中断**。若 harness 想加权限，用 [`withPermission(memoryWriteTool, ...)` 包一层](./04-checkpointer.md#tool-端interruptsignal-用法) |
| `Plugin 错误隔离` | `beforeModel` 抛 = [整轮 abort](./03-plugin.md#管道链与错误隔离)。所以 plugin 内部 fs 错误必须包成 logger.warn + 透传 messages，**不要让 IO 故障 abort 整个 agent** |

### 容错纪律

```ts
async beforeModel(ctx, messages) {
  try {
    const mem = await readMemoryWithCache();
    return injectIntoSystem(messages, mem);
  } catch (err) {
    ctx.logger.warn('fs-memory: read failed, skipping injection', err);
    return [...messages];   // 故意不抛
  }
}
```

这是 plugin 设计自检 #5（"失败该不该阻塞"）的体现：memory 是**增益**，不是**契约**——磁盘坏了 agent 仍要能跑。tools 内的写入失败正常抛错，由 framework 包成 `tool_result.is_error=true` 喂给 LLM。

---

## 六、MEMORY.md 写入策略

按你的决议（Q4 = b + 短期不实现 self-compact）：

**v1 范围**：
- MEMORY.md 由用户手写起步
- LLM 通过 `memory_write` 写入离散 facts 到 `facts/`
- 不做自动 self-compact

**Future work（架构层面预留，v1 不实现）**：

定期把 `facts/` 里的高频 / 高重要度内容**提升**到 MEMORY.md，避免 MEMORY.md 永远不变同时 facts/ 无限增长。两种触发模式：

| 模式 | 触发时机 | 谁执行 |
|---|---|---|
| 显式 tool | `memory_promote(factPath)` | LLM 主动调，从 facts/ 拷贝/摘要到 MEMORY.md |
| 后台 compact | `facts/` 文件数 > 阈值 | harness 层 cron 任务调 LLM 摘要 |

为什么 v1 不做：self-compact 涉及 LLM 调用 + 摘要质量评估，是独立的工程问题，与 plugin 接口解耦。v1 用户可以手动维护 MEMORY.md，已经能跑。

---

## 七、API

```ts
// @my-agent-team/plugin-fs-memory

export interface FsMemoryOptions {
  /** 记忆根目录。MEMORY.md 和 facts/ 都在这里下面 */
  dir: string;
  /** 是否启用 memory_write tool。默认 true */
  enableWrite?: boolean;
  /** memory_search 默认 top N。默认 5 */
  searchLimit?: number;
}

export function fsMemoryPlugin(options: FsMemoryOptions): Plugin;
```

调用方：

```ts
import { createAgent } from '@my-agent-team/framework';
import { fsMemoryPlugin } from '@my-agent-team/plugin-fs-memory';

const agent = createAgent({
  model,
  systemPrompt: 'You are a helpful coding assistant.',
  plugins: [
    fsMemoryPlugin({ dir: '/home/user/.my-agent/memory' }),
  ],
});
```

注意：调用方**不传 tools**，三个 memory tools 由 plugin 自动声明并合并（[Plugin.tools 字段](./02-framework.md#plugin)）。

---

## 八、设计自检对照

按 [Plugin 设计自检 checklist](./03-plugin.md#设计自检-checklist) 逐条对照：

1. **它真的需要看 agent 内部执行节点吗？** 是。bootstrap 注入必须命中 `beforeModel`，不能用 tool 替代
2. **它的逻辑能用 4 个钩子表达吗？** 能。只用 `beforeModel`
3. **依赖什么？** 依赖 `core` 类型 + `node:fs/promises`。**不依赖**具体 model / adapter / harness
4. **多个实例需要互相通信吗？** 不需要
5. **失败该不该阻塞？** before* 钩子内 try/catch 降级；tools 抛错正常上报。增益不是契约

---

## 九、不做的事（永久性技术契约）

- **不内置 embedding** — v1 纯 substring search。embedding 留独立适配包
- **不维护 `.index.json`** — `memory_search` 全扫 + mtime cache，避免双写一致性问题
- **不 fsync** — 与 [fileCheckpointer 同款](./04-checkpointer.md#filecheckpointer)；memory 是增益不是契约
- **不做跨 session memory 同步** — memory 是本地目录；分布式同步用 NAS / git 自己解决
- **不做 memory 权限模型** — 文件系统权限就是权限模型；要 ACL 用 [`withPermission`](./04-checkpointer.md#tool-端interruptsignal-用法) 包 tool
- **不持有跨 agent 全局状态** — 单 plugin 实例内的 mtime cache 是允许的（[Plugin 能力边界](./03-plugin.md#能力边界)的"用 closure 自己存"）；不在模块顶层放共享 Map
- **MEMORY.md 缺失视为空** — plugin 不自动创建空文件；`dir` 不存在则 `mkdir -p`

---

**Plugin 文档结束。** 兄弟文档：[Progressive Skill](./07-plugin-progressive-skill.md)。