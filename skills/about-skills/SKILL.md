---
name: about-skills
description: 解释技能系统如何工作——如何使用 skill_load、理解 available-skills 索引、以及 ${SKILL_DIR} 如何解析为真实文件路径。
---

# 关于技能系统

这份技能本身就是技能系统的自举文档。阅读它可以帮助你理解如何有效使用技能。

## 什么是技能

技能是一个目录，包含一个 `SKILL.md` 文件（带 YAML frontmatter 的 name 和 description）以及可选的脚本和资源文件。

## 如何发现可用技能

在每次对话开始时，系统会在上下文末尾注入一个 `<available-skills>` 块，列出所有可用技能的 name 和 description。你不应该假设某个技能存在——先查看索引。

## 如何加载技能

调用 `skill_load` 工具，传入技能名称：

```
skill_load("about-skills")
```

加载后，技能正文会注入到你的上下文中。加载是幂等的——重复加载同一技能不会重复注入。

## SKILL_DIR 是什么

技能正文中可能包含 `${SKILL_DIR}` 占位符。它会在加载时被解析为该技能所在目录的真实磁盘路径。例如：

```
用 bash 执行：python3 ${SKILL_DIR}/scripts/analyze.py
```

会被解析为：

```
用 bash 执行：python3 /path/to/skill-packs/<pack-id>/about-skills/scripts/analyze.py
```

这使得技能可以引用同目录下的脚本和资源文件。

## 注意事项

- 技能按需加载：不要预先加载所有技能，只在需要时加载
- 技能来自已分配给你的技能包（skill pack）
- 如果有多个技能包包含同名技能，后加载的包会覆盖先加载的
- 你可以通过 `${SKILL_DIR}` 读取同目录下的资源文件
