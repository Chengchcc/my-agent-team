---
id: plugins.progressive-skill
title: 渐进式技能插件
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "渐进式技能插件（progressiveSkillPlugin）解决「技能很多但上下文有限」的矛盾。它不把所有技能正文一股脑塞进提示，而是先通过 beforeModel 只注入一份技能索引（元数据），等 Agent 判断需要某个技能时，再用 skill_load 工具按需把那一个技能的正文加载进来。技能存在 AgentFS 的 /skills/ 下，归 private 域。"
depends_on:
  - runtime.plugin
  - runner.agent-file-system
used_by:
---

# 渐进式技能插件

渐进式技能插件（progressiveSkillPlugin）解决「技能很多但上下文有限」的矛盾。它不把所有技能正文一股脑塞进提示，而是先通过 beforeModel 只注入一份技能索引（元数据），等 Agent 判断需要某个技能时，再用 skill_load 工具按需把那一个技能的正文加载进来。技能存在 AgentFS 的 /skills/ 下，归 private 域。

## 为什么「渐进式」

如果把每个技能的完整说明都写进系统提示，技能一多，提示就爆了，而且大部分技能这一轮根本用不上。渐进式加载的思路是**两段式**：

1. 先给一份「目录」——只放技能的名字和简介（索引/元数据）；
2. Agent 看目录决定要用哪个，再去取那一个的「正文」。

这样提示里常驻的只有轻量索引，重的正文按需才进上下文。

## 索引注入：beforeModel

插件用 `beforeModel` 钩子，在每次模型调用前把技能索引拼进系统提示。Agent 因此始终知道「有哪些技能可用」，但不被它们的完整内容淹没。

索引以 `<available-skills>` XML 块的形式注入系统提示（`progressive-skill.ts` 第 62-68 行），每条技能显示 `name` 和 `description`，末尾附指令：`Call skill_load(name) to load the full instructions for a skill before using it.`

## 按需加载：skill_load

当 Agent 决定使用某个技能，它调用 `skill_load` 工具，把那个技能的正文加载进来。触发完全由 Agent 自己的判断驱动——不是预先全量，也不是规则硬编码，而是「需要时才取」。

`skill_load` 支持 `offset` 参数用于分页续读：技能正文一次加载有字符上限（默认 8000），超出时在段落边界截断，并返回 `[Truncated. Call skill_load('name', offset=N) to continue.]` 提示。Agent 可以传 `offset` 继续读取剩余内容（`skill-load.ts` 第 44-63 行）。

## 技能放在哪

技能文件落在 AgentFS 的 `/skills/` 前缀下。该前缀实际别名到 `/private/skills/*`，归 **private** 域——技能是这个 Agent 私有的能力集，不跨 Agent 共享。

每个技能是一个**目录**，内含 `SKILL.md` 文件。插件扫描 `/skills/*/SKILL.md`（`cache.ts` 第 49-50 行）。`SKILL.md` 须有 YAML frontmatter，包含 `name`（技能名）和 `description`（简介）字段。插件按 frontmatter 后的 `bodyOffset` 截取正文，使 `skill_load` 只返回技能正文而跳过 frontmatter 元数据（`cache.ts` 第 13-32 行）。

## 关联页面

- [运行时插件机制](../runtime/plugin.md)
- [Agent 文件系统](../runner/agent-file-system.md)
- [Harness 默认装配](../harness/harness.md)
