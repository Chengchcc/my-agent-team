# Edit/Read 工具使用规范

## 核心规则

**大文件改动（>3 次 edit）→ 全量 `write`，不用链式 `edit`。**

## edit 的三个坑

1. **Tag 过期**：每次 edit 后文件 hash 刷新，前一读的 tag 作废。链式编辑需要每次 edit 前 `read` 重新拿 tag。
2. **Auto-repair 吞字段**：`SWAP` 遇到缩进/括号匹配错误会 auto-repair，可能删掉相邻的结构字段（`updatedAt`、`resumeRun`、闭合 `}`）。换 `write`。
3. **Summarized 模式**：不带行号的 `read` 会折叠文件，折叠区域内行号的 edit 被拒。换 `read path:1-300` 精确读。

## write 的使用时机

- 文件已被编辑 2 次以上 → 读全文 → `write` 完整文件
- 文件结构复杂（嵌套 YAML、JSON、大量函数）→ 直接 `write`
- sed 是最后手段——循环、条件、多行替换都别用 sed
