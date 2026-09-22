---
name: about-skills
description: 解释技能系统怎么用——`skill_load` 怎么取正文、每轮 Meta 里的 Skills 索引、`${SKILL_DIR}` 如何解析成真实路径。
---

# 关于技能系统

这份技能只讲怎么用技能。技能系统的实现详表（索引与正文两段式、技能根的顺序、frontmatter 开关）在 `docs/architecture/plugins/progressive-skill.md`。

## 什么是技能

技能是一个目录，包含一个 `SKILL.md` 文件（带 YAML frontmatter 的 name 和 description）以及可选的脚本和资源文件。

## 如何发现可用技能

技能索引在每轮的 `<system-reminder>` 里，是一个叫 Skills 的 Meta 段，列出所有可用技能的 name 和 description。你不应该假设某个技能存在——先查看索引。

## 如何加载技能

调用 `skill_load` 工具，传入技能名称：

```
skill_load("about-skills")
```

加载后，技能正文会注入到你的上下文中。

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
- 多个技能包含同名技能时，先出现的根胜出，后到的同名技能被丢弃
- 你可以通过 `${SKILL_DIR}` 读取同目录下的资源文件
