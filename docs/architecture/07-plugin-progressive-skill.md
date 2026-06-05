# Plugin: Progressive Skill

技能渐进式加载 plugin。把"agent 会哪些技能"做成一个**目录里的多个 SKILL.md**——每个 SKILL.md 由 frontmatter（name + description）和 body（详细指令）组成。plugin 在每轮 LLM 调用前自动注入 skill **索引**（只 name + description），LLM 需要时通过 tool 主动加载某个 skill 的**正文**。

> 这是 [Plugin](./03-plugin.md) 的一个具体实现，与 [fsMemory](./06-plugin-fs-memory.md) 是兄弟形态：都走 `beforeModel` + 自带 tools。

---

## 一、为什么需要这个 plugin

agent 想"会很多技能"但不能全塞 system——这是 context window 的物理约束直接产物。

### 不引入 plugin 的替代方案

| 方案 | 为什么不够 |
|---|---|
| 把所有 skill 全文拼 system prompt | 30 个 skill × 2KB = 60KB 直接吃光预算；多数 skill 用不上 |
| 让 LLM 自己 `Read` skill 文件 | LLM 不知道有哪些 skill；需要先 `glob` 再 `read`，多一轮无用调用 |
| 做成 harness preset（写死在 system） | 不能动态加 skill；用户加新技能要发版 |

### 第一性事实

**LLM 需要先看到"有哪些 skill 可用"，才能决定加载哪一个。** 这是 progressive disclosure 的本质：

- **摘要**（name + description，~50 tokens/skill × 30 个 ≈ 1.5KB）→ 注入到 system
- **正文**（每个 skill ~2KB）→ tool 按需 fetch

这正好是 [Claude Code Skills 的设计形态](https://www.anthropic.com/news/agent-skills)——名字、加载机制都直接对齐工业实践。

---

## 二、目录结构

遵循 Claude Code 设计（Q5 决议）：

```text
${dir}/
├── pdf-extract/
│   ├── SKILL.md                # frontmatter + body
│   ├── extract.py              # skill 自带资源（脚本/模板）
│   └── examples/
├── docx-generate/
│   └── SKILL.md
├── data-viz/
│   └── SKILL.md
└── ...
```

`SKILL.md` 格式：

```markdown
---
name: pdf-extract
description: 从 PDF 文件提取文本和表格，支持扫描件 OCR。
---

# PDF Extract Skill

When the user asks to extract content from a PDF:

1. Check whether the PDF is scanned by running `python ${SKILL_DIR}/check_scanned.py`
2. For scanned PDFs, use `${SKILL_DIR}/ocr.py` ...
```

- **frontmatter 必需字段**：`name`、`description`
- **description 长度建议** ≤ 200 字符（注入 token 预算的硬约束）
- **body 是 LLM 加载后的执行指令**——可以引用 `${SKILL_DIR}` 占位符指向 skill 目录绝对路径

**发现路径**：固定 `${dir}/*/SKILL.md`（一层嵌套）。**不支持**深层 glob——目录结构就是 skill 的命名空间，深层嵌套会让 name 冲突管理混乱。这与 Q5 决议一致。

---

## 三、注入策略

### 阶段 1：每轮注入 skill 索引

plugin 在 `beforeModel` 扫描 `${dir}/*/SKILL.md` 的 frontmatter（不读 body），拼成索引段追加到 system message 末尾：

```ts
async beforeModel(ctx, messages) {
  const skills = await loadSkillIndexWithCache();   // mtime cache per dir
  if (skills.length === 0) return [...messages];

  const indexBlock = renderIndex(skills);
  return injectIntoSystem(messages, indexBlock, ctx);
}

function renderIndex(skills: SkillMeta[]): string {
  const lines = skills.map(s => `- **${s.name}**: ${s.description}`);
  return `<available-skills>
${lines.join('\n')}

Call \`skill_load(name)\` to load the full instructions for a skill before using it.
</available-skills>`;
}
```

### 阶段 2：LLM 调 `skill_load(name)` 加载正文

`skill_load` tool 返回 SKILL.md 的 body 部分（去掉 frontmatter），通过 `tool_result` 进入 thread.messages：

```ts
{
  name: 'skill_load',
  description: 'Load the full instructions for an available skill.',
  inputSchema: { name: 'string', offset: 'number?' },
  async execute({ name, offset = 0 }) {
    const skill = await findSkill(name);
    if (!skill) return { content: `Skill not found: ${name}`, isError: true };
    return loadSkillBody(skill, offset);
  },
}
```

### 注入位置：system 末尾（与 fsMemory 同源）

直接对齐 [fsMemory 的注入决议](./06-plugin-fs-memory.md#为什么拼-system-而不是新建-user-消息)——工业一致实践。

如果 fsMemory 和 progressiveSkill 同时启用且都拼 system 末尾，**plugins 数组顺序决定追加顺序**（[Plugin 管道链与错误隔离](./03-plugin.md#管道链与错误隔离)）：先 fsMemory 追加 `<memory>...`，再 progressiveSkill 追加 `<available-skills>...`，两段并列在 system 末尾。

### 没有 system 时的行为

同 fsMemory：plugin **跳过注入 + warn**，不替用户插 system message。

---

## 四、Tools

plugin 通过 `Plugin.tools` 静态声明：

| Tool | 入参 | 返回 | 副作用 |
|---|---|---|---|
| `skill_load` | `{ name: string; offset?: number }` | SKILL.md body 或截断后的片段 + `next_offset` | 无 |

为什么只有一个 tool：

- `skill_list` 不需要——索引已经注入 system，LLM 天然看见
- `skill_search` 不需要——v1 skill 数量在 10-50 量级，描述都在 system 里，LLM 直接基于自然语言判断
- `skill_create` / `skill_edit` 不在 plugin 范围——skill 是 harness/用户管理的资产，plugin 只消费

### `skill_load` 截断策略（Q7 决议 = b）

skill body 可能很长（几千 tokens）。一次 tool_result 太大会污染 context。策略：

```ts
const MAX_CHARS_PER_LOAD = 8000;  // ~2k tokens

async function loadSkillBody(skill, offset) {
  const body = await fs.readFile(skill.path, 'utf-8').then(stripFrontmatter);
  if (offset >= body.length) {
    return { content: `Skill ${skill.name} fully loaded.`, isError: false };
  }
  const chunk = body.slice(offset, offset + MAX_CHARS_PER_LOAD);
  const nextOffset = offset + chunk.length;
  const hasMore = nextOffset < body.length;
  const suffix = hasMore
    ? `\n\n[Truncated. Call skill_load('${skill.name}', offset=${nextOffset}) to continue.]`
    : '';
  return { content: chunk + suffix, isError: false };
}
```

**为什么不让 [ContextManager.toolResultTruncator](./05-context-manager.md) 处理**：truncator 是事后被动截断，会丢内容；这里是主动分页，让 LLM 决定是否需要后续。语义不同。

---

## 五、与 framework 其他组件的边界

| 组件 | 关系 |
|---|---|
| `ContextManager` | 不重叠。skill 正文一旦通过 `skill_load` 进 thread.messages，就是普通 message，会被 CM 视作可截断对象。**这是有意的**——skill 用完后被滑窗淘汰是正常生命周期，需要时 LLM 再 load 一次 |
| `Checkpointer` | skill 正文在 thread.messages 中被 save。resume 后历史里包含已加载的 skill 正文，不需要重新 load |
| `Logger` | plugin 用 `ctx.logger.debug` 输出"扫描到 N 个 skill"、"LLM 加载了 skill X" |
| `InterruptSignal` | `skill_load` 是只读 IO，不需要中断 |
| `fsMemoryPlugin` | 完全独立。共享 system 末尾追加机制，但内容隔离（不同 XML 标签） |

### 容错纪律

与 fsMemory 同款：

```ts
async beforeModel(ctx, messages) {
  try {
    const skills = await loadSkillIndexWithCache();
    return injectIntoSystem(messages, renderIndex(skills));
  } catch (err) {
    ctx.logger.warn('progressive-skill: load failed, skipping injection', err);
    return [...messages];
  }
}
```

skill 是**增益**不是**契约**——磁盘坏 / 某个 SKILL.md frontmatter 解析失败，**不应该 abort 整个 agent**。

frontmatter 解析失败的单个 skill：跳过 + warn + 继续处理其他 skill。不全有全无。

---

## 六、`${SKILL_DIR}` 占位符

skill body 里可以引用 skill 自带的资源文件：

```markdown
# pdf-extract

For OCR: run `python ${SKILL_DIR}/ocr.py <input.pdf>`.
```

plugin 在 `skill_load` 返回正文前做字符串替换：

```ts
body = body.replaceAll('${SKILL_DIR}', path.resolve(skill.dir));
```

这让 SKILL.md 与具体安装路径解耦——同一份 skill 可以放在 `/home/alice/skills/` 或 `/opt/skills/`，body 不用改。

---

## 七、API

```ts
// @my-agent-team/plugin-progressive-skill

export interface ProgressiveSkillOptions {
  /** Skill 根目录。扫描 `${dir}/*/SKILL.md` */
  dir: string;
  /** 单次 skill_load 返回的最大字符数。默认 8000 */
  maxCharsPerLoad?: number;
}

export function progressiveSkillPlugin(options: ProgressiveSkillOptions): Plugin;
```

调用方：

```ts
import { createAgent } from '@my-agent-team/framework';
import { progressiveSkillPlugin } from '@my-agent-team/plugin-progressive-skill';
import { fsMemoryPlugin } from '@my-agent-team/plugin-fs-memory';

const agent = createAgent({
  model,
  systemPrompt: 'You are a helpful assistant.',
  plugins: [
    fsMemoryPlugin({ dir: '~/.my-agent/memory' }),
    progressiveSkillPlugin({ dir: '~/.my-agent/skills' }),
  ],
});
```

`skill_load` 由 plugin 自动声明并合并到 agent 的 tool 列表（[Plugin.tools 字段](./02-framework.md#plugin)）。

---

## 八、设计自检对照

按 [Plugin 设计自检 checklist](./03-plugin.md#设计自检-checklist) 逐条对照：

1. **它真的需要看 agent 内部执行节点吗？** 是。index 注入必须命中 `beforeModel`
2. **它的逻辑能用 4 个钩子表达吗？** 能。只用 `beforeModel`
3. **依赖什么？** 依赖 `core` 类型 + `node:fs/promises` + 任一 yaml frontmatter 解析器
4. **多个实例需要互相通信吗？** 不需要。一个 agent 一般只挂一个 skill 目录
5. **失败该不该阻塞？** 不阻塞。降级 + warn

---

## 九、不做的事（永久性技术契约）

- **不内置 skill 商店 / 下载** — skill 是文件目录；分发用 git / npm / rsync
- **不内置 skill 版本管理** — 用文件系统快照 / git 解决
- **不支持深层 glob** — 固定一层 `${dir}/*/SKILL.md`
- **不缓存 skill body** — 只缓存 index 元数据（frontmatter + mtime）。body 每次 `skill_load` 重读，避免一致性问题
- **不做 skill 依赖图** — 如果 skill A 依赖 skill B 的能力，让 LLM 自己读 A 后判断要不要 load B；不在 plugin 层做依赖解析

---

## 十、与 fsMemory 的对照

两个 plugin 形态对称，便于对比记忆：

| 维度 | fsMemory | progressiveSkill |
|---|---|---|
| 注入内容 | MEMORY.md 全文 | SKILL.md frontmatter 索引 |
| 注入时机 | 每轮 `beforeModel` | 每轮 `beforeModel` |
| 注入位置 | system 末尾 | system 末尾 |
| 是否分页 | 否（MEMORY.md 应保持精炼） | 是（skill body 通过 `skill_load(offset)` 分页） |
| 写入路径 | `memory_write` tool 追加 facts | 不提供写入——skill 是用户管理资产 |
| 检索路径 | `memory_search` keyword search | 不需要——索引天然可见 |
| 容错策略 | 降级 + warn，不 abort | 降级 + warn，不 abort |
| 单 skill/fact 失败 | 单条 fact 损坏不影响其他 | 单个 SKILL.md frontmatter 解析失败跳过该 skill，其他继续 |

---

**Plugin 文档结束。** 兄弟文档：[FS Memory](./06-plugin-fs-memory.md)。
