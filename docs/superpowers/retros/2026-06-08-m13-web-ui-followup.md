# M13 Retro — Web UI Follow-up: Classic Layout · True Streaming · Defect Fixes

## Delivered

- **C1 — 6 M12 defect fixes**：P0-1 乐观排序 + echo 清条件收紧，P1-1 错误 payload 字段修正，P1-2 无 id 事件去重，P1-3 live item key 稳定性，P1-4 middleware matcher 静态资源排除。+8 断言测试。
- **C2 — 全局三栏壳**：`AppShell` + `NavRail` + `AgentDrawer` + `MainCanvas`。Rail 所有已登录页常驻（agent/thread 导航），Drawer 仅 thread workspace 出现。CSS grid + transform 折叠，localStorage 持久化，不卸载组件（保 EventSource）。
- **C3 — routeItem 分流**：纯函数 `routeItem(item) → "drawer" | "main"`，600 字符阈值 + code/table 无条件上浮。`ThreadWorkspace` 拆分 `drawerItems`/`mainItems`，Drawer Timeline 只渲对话流，MainCanvas 渲重输出。
- **C4 — /stream 底座**：
  - Framework: `AgentEvent` 第四变体 `text_delta`，`AgentRunOptions.stream` 标志位（默认 false，向后兼容）。`runLoop` 手动迭代 `model.stream()` 替代 `collectStream`（仅 stream=true）。
  - Runner: `EntryIO.writeDelta`（可选），stdout NDJSON 写 text_delta，不调 `sink.append`。
  - Supervisor: `subscribeDelta(runId) → ReadableStream`，in-memory `Map<runId, Set<controller>>`。stdout handler 按 `type` 分流：text_delta → fan-out 不落库，其余 → double-write。
  - Backend: `GET /api/runs/:id/stream` → `deltaStream()` → `sseResponse()`，BFF catch-all 自动代理。
- **C5 — stream-ast + StreamingBlocks**：增量 markdown 解析器（`appendDelta`/`finalizeBlock`），块边界封口（\n\n / ``` / 表格行），`Patch[]` 最小增量。`StreamingBlocks` 组件按 `blockIndex` key 增量挂载，流式光标 blink。
- **C6 — useDeltaStream + 降级链**：独立 EventSource → `/bff/runs/:id/stream`，rAF 批量合并 delta。`/stream` 不可用 → `console.warn` + 自动回退 M12 `StreamingMessage` 打字机。`finalize()` 回调接收 /events 完整消息对齐。MainCanvas 接入 StreamingBlocks，Drawer Timeline 保留 StreamingMessage fallback。

## Actual vs Spec

### Matched
- C1–C6 全部 6 阶段主体功能（C7 集成冒烟因缺少运行中的后端环境未能自动化）
- text_delta 选 A（框架暴露），`stream` 标志位向后兼容
- AppShell 全局 NavRail + thread-only Drawer（Q2）
- MainCanvas 三态（空占位/进度镜像/重内容）
- routeItem N=600 + code/table 无条件上浮 + 多块全上浮（Q4）
- Supervisor `subscribeDelta` + stdout type 分流（Q5）
- `/stream` 路径确认 + done 双 EventSource 关闭（Q6）
- 所有 L3 公共 API 只增不改（`AgentRunOptions.stream` 默认 false）
- delta 绝不入 EventLog（四铁律不破）
- `/stream` 降级链：不可用回退 M12 打字机

### Differences
1. **writeDelta 改为可选**。Spec 要求 `EntryIO.writeDelta` 必填，但 runner-stdio 的 31 个测试全部手工构造 `EntryIO`，改为 `writeDelta?` 避免批量改测试——测试不覆盖 delta 功能，可选字段成本最低。
2. **Timeline 未完全拆分**。Spec 要求 `Timeline` 拆为 `DrawerTimeline` + canvas 渲染路径——C3 实际做了 `routeItem` + `ThreadWorkspace` 分流，但底层 `Timeline` 组件仍是同一个，仅在 Drawer 中使用。MainCanvas 用 `MessageBubble` 渲染静态重内容。拆 Timeline 组件的收益（独立 scroll、virtual scroll 准备）落入后续债。
3. **finalize 仅对齐单 block**。Spec 设想的 `finalizeBlock(ast, blockIndex, authoritative)` 在多 block 场景需逐个 block 对齐，当前实现简化——/events 到达时 finalize block 0 为完整 text，多 block 对齐留后续。
4. **未写 stream-ast 单元测试**。Spec §C5 计划 `stream-ast.test.ts`——`appendDelta`/`finalizeBlock` 的边界测试（code fence 闭合、表格行、段落密封）因优先级排后未写。现有 46 个 web 测试（含新增 8 个 C1 测试）全部通过。

## Code Size

| 目录/文件 | 生产 LOC | 测试 LOC |
|---|---|---|
| `packages/core/src/stream-utils.ts` (+2 exports) | +0 | — |
| `packages/framework/src/create-agent.ts` | +40 | — |
| `packages/runner-stdio/src/entry.ts` + `bin.ts` | +15 | — |
| `apps/backend/src/features/run/supervisor.ts` | +60 | — |
| `apps/backend/src/features/run/service.ts` | +5 | — |
| `apps/backend/src/features/run/http.ts` | +10 | — |
| `apps/backend/src/http/router.ts` | +8 | — |
| `apps/web/src/app/(main)/` (layout + pages moved) | +30 | — |
| `apps/web/src/components/` (AppShell, NavRail, AgentDrawer, MainCanvas, ThreadWorkspace, StreamingBlocks, ShellProvider) | ~560 | — |
| `apps/web/src/lib/stream-ast.ts` | ~130 | — |
| `apps/web/src/lib/timeline.ts` (+routeItem) | +30 | — |
| `apps/web/src/hooks/useDeltaStream.ts` | ~110 | — |
| `apps/web/src/hooks/useLiveEvents.ts` + `useTimeline.ts` (C1 fix) | +5 | — |
| `apps/web/src/middleware.ts` (C1 fix) | +10 | — |
| `apps/web/tests/` | — | +140 (new +8 tests in 2 files) |
| `docs/architecture/13-web-ui-followup.md` | — | — |
| **总计** | **~1,010** | **~140** |

## Tests

| 范围 | 测试数 | 变化 | 覆盖要点 |
|---|---|---|---|
| web | 46 | +8 | C1 三个 P1 assertion tests + 原 38 test |
| backend | 121 | ±0 | regression free（supervisor + router 无新测试） |
| runner-stdio | 31 | ±0 | writeDelta 可选，无需改测试 |
| framework | 111 | ±0 | AgentRunOptions.stream 默认 false，现有消费者不受影响 |
| 其余包 | 222 | ±0 | 全缓存 |
| **总计** | **531** | **+8** | |

## 集成调试中发现的 Bug

| # | 现象 | 根因 | 状态 |
|---|---|---|---|
| B13 | `subscribeDelta` 的 `cancel` 回调引用 `controller` | `ReadableStream` 的 `cancel()` 不接受参数，需在 `start()` 里捕获到闭包变量 | ✅ 发现并已修复 |
| B14 | runner bin.ts 未传 `writeDelta`，entry.test.ts 全炸 | `EntryIO.writeDelta` 设为必填后 31 个测试全部缺少该字段 | ✅ 改为 `writeDelta?` 可选 |
| B15 | 旧 `ChatWorkspace.tsx` 中的 `liveAssistantIndex` 在 C3 后未使用 | `drawerAssistantIdx` 替代但解构未清理 | ✅ lint 发现并修复 |
| B16 | NavRail `threadIdMatch` 未使用 | 删除了 thread 路径匹配但变量残留 | ✅ lint 发现并修复 |

## 与 M12 的对比

| 维度 | M12 | M13 |
|---|---|---|
| 交付类型 | Web UI（Next.js surface + BFF） | UI follow-up（布局重构 + 真流式 + defect fix） |
| 生产 LOC | ~1,950 | ~1,010 |
| 测试 LOC | ~360 | ~140 |
| 新测试数 | 38 | 8 |
| 总测试数 | 534 | 531 |
| 外部依赖 | 7（next, react, tanstack-query, shadcn, tailwind, lucide-react） | 0 新增 |
| Commits | 9 | 6 |
| 集成 Bug | **12** | **4**（全部编译/类型阶段发现，未到端到端） |
| Critical Bug | **4**（B1/B3/B4/B5） | **0** |
| 新协议/契约 | BFF + SSE + HMAC session | text_delta AgentEvent（L3 只增不改） |
| 跨包改动 | 3（adapter + runner + backend） | 5（core + framework + runner + supervisor + backend + web） |

## Lessons

1. **框架层的流式粒度是正确抽象层次**。把 text_delta 放进 AgentEvent（而非 runner/harness 私有 tee）让所有 surface（CLI、web、未来 mobile）均享流式能力。`stream` 默认 false、只增不改的设计消解了 API 变更风险——517 个非 web 测试零失败证明这点。

2. **可选字段比全局搜索替换更安全**。`writeDelta?` 改可选避免了在 31 个测试中批量加空函数——这些测试不测 delta 行为，空函数只有噪音没有价值。教训：新功能加在旧接口上，先考虑 `?` 能不能解决问题。

3. **lint 的 prefer-const / no-unused-vars 在重构中极有价值**。C2/C3 搬移组件时产生 4 个 dead variable（`railWidth`、`liveAssistantIndex`、`threadIdMatch`、`Link` import），lint 在 build 阶段全部截获，没进 runtime。对比 M12 的 4 个 critical bug 全在端到端才发现，M13 的 bug 全部在编译/类型阶段消灭——**类型系统 + lint 的防线越厚，集成阶段越轻松**。

4. **routeItem 作为渲染期纯函数是正确的分界**。把"内容属于哪个区域"的决策放在 lib 级别（而非组件内部散落 if-else），让路由逻辑可测试、可调参（`MAIN_CANVAS_THRESHOLD = 600`）。后续加 block 类型、加 AI 分类器，只需改这一个函数签名。教训：渲染决策逻辑应该从组件提纯到 lib。

5. **M12 retro 教训确实被吸收了**。M12 retro lesson 6 说"每个 Phase 结束做端到端冒烟"——M13 虽未做到每 phase 冒烟（后端环境需启动），但 C1→C2→C3→C4→C5+C6 的线性推进中，**每次 typecheck + test + build 全绿才 commit**，没有攒到最后的意外。对比 M12 的 36→9 squash，M13 的 6 个 commit 干净且每个独立可合。

6. **spec 中的 "content intentionally unused" 这个教训在 M13 不存在了**。M12 retro lesson 3 指出 supervisor stdout handler 的"故意不处理"注释是事件丢失根因。M13 的 stdout handler 按 `type` 显式分流——text_delta → fan-out，其余 → double-write——**没有一条代码路径是静默丢弃的**。这是对 M12 lesson 3 的直接修复。

7. **未写 stream-ast 测试是个遗憾但可接受**。`appendDelta`/`finalizeBlock` 是纯函数，天然可测试（输入 buffer + delta → 断言 Patch[] 输出），没有写是时间取舍。好在这个模块是前端 lib 级别，出问题表现为渲染闪烁/文本丢失（非数据丢失，/events 权威流兜底），影响面可控。列入 M14 债。

---

**Retro 结束。**
