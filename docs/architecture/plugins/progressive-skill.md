---
title: 渐进式技能
description: 技能索引进 Meta 段、正文由 skill_load 按需读的机制，含技能根顺序、同名优先级与两个 frontmatter 开关
tags: [skills, runtime, context]
---

# 渐进式技能

一句话：本页是技能渐进加载的权威描述。它是 oma 的一个内置模块（`createSkill({ roots })`）——把技能的**索引**（名字与简介）放进每轮的 Meta 段，把**正文**留给 `skill_load` 工具按需读取，所以技能再多也不会一次占满上下文。

## 范围

覆盖：索引与正文的两段式、Meta 段与 `skill_load` 的契约、技能根从哪来、`/skill:<name>` 与两个 frontmatter 开关、重复技能的优先级。

不覆盖：技能包的分发与安装（见 [技能包管理](./skill-pack.md)）、工作区里的技能软链怎么来（见 [Agent 工作区与多后端](../agents/workspace-and-backends.md)）、`manage_skill` 工具的权限与超时（见 [Oma Tools](../runtime/oma-tools.md)）。

## 实现文件

- `apps/oh-my-agent/src/core/tools/skill.ts` — `createSkill`：Meta 段与 `skill_load` 工具
- `apps/oh-my-agent/src/core/tools/skills.ts` — `buildSkillIndex`：扫描、frontmatter 解析、去重与排序
- `apps/oh-my-agent/src/core/runtime/run-runtime.ts` — 技能根的组装与 `refreshSkills` 的接线
- `apps/oh-my-agent/src/core/runtime/prompt.ts` — Meta 段的渲染位置
- `apps/oh-my-agent/src/cli/initial-input.ts` — 独立 CLI 的技能根解析
- `apps/oh-my-agent/src/modes/tui/{tui-slash,tui-commands}.ts` — `/skill:<name>` 的注册与 `/skill` 的列出
- `apps/oh-my-agent/src/core/memory/managed-skills.ts` — 受管技能目录与写入约束

## 索引与正文两段式

索引在装配时生成一次：扫描每个技能根下的 `SKILL.md`，从 frontmatter 取 `name` 与 `description`，拼成 Meta 的一个段；正文只在模型调 `skill_load` 时读。Meta 段每次都读模块当前的索引，`refresh()` 会重新扫描全部根——所以运行中新增的技能对 `skill_load` 与**后续**的 Meta 渲染立即可见；已经烤进本轮提示的部分要等下一个 Run。

索引文本就是一段 markdown 列表，段名 `Skills`，一行一个：

```text
- **release-flow**: 发版流程
- **incident-triage**: 事故分诊
```

没有可用技能时这一段的正文是 `No skills available.`。

## Meta 段与 skill_load 契约

Meta 段由插件系统的 `meta` 提供者渲染，包在每轮那条 `<system-reminder>` 用户消息里（和 `Current Tasks` 段同一个位置）。

`skill_load` 只接受一个参数：

```json
{ "name": "release-flow" }
```

返回四样东西：

| 字段 | 内容 |
|---|---|
| `name` | 技能名 |
| `dir` | `SKILL.md` 所在目录 |
| `hint` | 提示把相对路径与脚本按 `dir` 解析 |
| `body` | 去掉 frontmatter 的正文，正文里的 `${SKILL_DIR}` 已替换成真实目录 |

越界检查在读取前做：解析出的路径必须落在该技能根之内（realpath 比较），否则返回 `Path escape detected`；找不到该名字返回错误，不会去猜。

## 技能根从哪来

`createSkill({ roots })` 的 roots 是数组，数组**顺序就是优先级**。

产品路径（rpc）：Run 创建时冻结的 `skillRoots`，内容是恒有的 builtin 技能目录加上该 Agent 已分配且状态为 READY 的 pack 安装目录（见 [技能包管理](./skill-pack.md)）。

独立 CLI（print / json / tui）：按顺序解析出候选根，只保留存在的目录——

1. `.oma/settings.json` 的 `skills` 列表（给了就替代默认值，绝对路径或相对工作区解析）；
2. 否则是 `<workspace>/.oma/skills` 与 `<agentDir>/skills`；
3. 启用的插件贡献的 `skills` 目录；
4. `<agentDir>/managed-skills` 固定排在最后。

**工作区可写**的 Run 会在 roots 末尾补上 `<agentDir>/managed-skills`，让运行中由 `manage_skill` 铸造的技能在同一个 Run 里就能被 `skill_load` 读到（`refresh()` 重新扫描；只读 Run 保持冻结的 roots）。

## 重复技能与顺序

同一个技能名在多个根里出现时，**先出现的根胜出**，后面的同名项直接丢弃——也就是靠前的根（工作区的 `.oma/skills`、产品快照里的 builtin 与 pack）压过靠后的（插件、受管技能）。索引最终按名字排序输出，与扫描顺序无关。

受管技能排最后就是这条规则的用法：同名的作者技能永远压住它（`learn` 铸造技能时也会拒绝对已被作者技能占用的名字）。

扫描有两个约束：符号链接必须落在根内，单个根下的条目总数上限 1000。

## `/skill:<name>` 与两个 frontmatter 开关

TUI 会给**每一个**被索引到的技能注册一条 `/skill:<name>` slash 命令；执行时提交的是一段提示词，让模型自己去 `skill_load` 取正文：

```text
Follow the "release-flow" skill (skill_load "release-flow" first).
```

带参数时参数在前，后面附同一句指引。`/skill` 列出当前发现到的技能。

两个 frontmatter 开关语义不同：

| frontmatter | 效果 |
|---|---|
| `hide: true` | 不进 Meta 索引，但 `skill_load` 仍然能取到它 |
| `user_invocable: false`（也接受 kebab 写法 `user-invocable`、`disableModelInvocation`、`disable-model-invocation`） | 意图是"不暴露这条 slash 命令" |

## 与 skill pack 的关系

技能包是分发单元，技能是这个模块的消费对象：pack 被安装并分配给某个 Agent 后，它的安装目录进 Run 的 `skillRoots`，里面的 `SKILL.md` 被这里的扫描器发现。二者之间只有"根目录"这一个接口，见 [技能包管理](./skill-pack.md)。

## 不变量

1. 索引里只有名字与简介；正文只在 `skill_load` 时读。
2. roots 的顺序就是优先级，同名先到先得。
3. `hide` 与"不可调用"是两件事，一个只管索引，一个只管 slash 命令。
4. `skill_load` 只按名字取，路径必须落在技能根内。
5. 受管技能永远排在最后，作者技能压过它。

## 已知缺口

- `user_invocable: false` 只被解析进索引项，**当前没有任何消费方**：TUI 注册 `/skill:<name>` 时不过滤它，所以标了这个开关的技能照样出现在命令表里。
- 后端另有一份扫描器副本（`apps/backend/src/features/skill-pack/skill-index.ts`），供技能包管理界面用。那份**不认** `hide` 与 `user_invocable`，重复名的优先级也不同（两份实现的重复调用点都只传一个根，所以目前观察不到差别）。改技能格式要同时看这两处。
- 单个根下超过 1000 个条目会直接抛错，没有降级路径。

## 相关页

- [Oma Tools](../runtime/oma-tools.md) — `skill_load` 与 `manage_skill` 在工具表里的位置
- [Oma Runtime](../runtime/oma.md) — Meta 段怎么进模型上下文
- [技能包管理](./skill-pack.md) — 技能从哪来
- [Agent 工作区与多后端](../agents/workspace-and-backends.md) — `.oma/skills` 里的软链
