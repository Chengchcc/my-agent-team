# Lobster 重构 · 主计划 (Master Plan)

> **For agentic workers:** 本项目按 7 个独立子系统分解, 每个子系统有独立的 plan 文件, 可独立实施. 按依赖顺序执行.

**Goal:** 完成 my-agent-dev 的 Lobster 架构重构, 实现 daemon-hosted 单 Agent + multi-frontend attach/detach + profile 三隔离 + Evolution 自我迭代闭环

**Architecture:** 按 5 层架构分层实施, 每层独立可测试, thin wrapper 保证迁移过程不破坏现有功能

**Tech Stack:** TypeScript, Bun, Zod, NDJSON, JSON-RPC 2.0, ESLint import/no-restricted-paths

---

## 子系统计划清单

| 序号 | Plan 文件 | 依赖 | 预估任务数 | 状态 |
|---|---|---|---|---|
| 1 | `2026-05-16-lobster-01-shared-config.md` | 无 | ~20 | ☐ |
| 2 | `2026-05-16-lobster-02-agent-core.md` | Spec 01 | ~25 | ☐ |
| 3 | `2026-05-16-lobster-03-session-layer.md` | Spec 02 | ~30 | ☐ |
| 4 | `2026-05-16-lobster-04-transport-protocol.md` | Spec 01, 03 | ~35 | ☐ |
| 5 | `2026-05-16-lobster-05-frontend-abstraction.md` | Spec 04 | ~30 | ☐ |
| 6 | `2026-05-16-lobster-06-evolution-integration.md` | Spec 02, 04 | ~20 | ☐ |
| 7 | `2026-05-16-lobster-07-migration-assembly.md` | Spec 02, 03, 05, 06 | ~25 | ☐ |

---

## 全局前置条件 (Step 0)

在开始任何子系统之前, 必须完成:

- [ ] Phase 1+2 全部 issue 闭合 (代码库基线稳定)
- [ ] `bun run check:all` 全绿
- [ ] 所有现有测试通过
- [ ] 确认 `ARCHITECTURE-CONSTITUTION.md` 规则 (重构中不能违反)
- [ ] 工作树已创建 (推荐)

---

## 迁移路径总览

```
Step 0: 基线稳定 ✓
  ↓
Step 1: shared/ + config/ 双层 TOML  『Plan 01』
  ↓
Step 2: core/agent-core.ts + bootstrap  『Plan 02』
  ↓ (runtime.ts 变 thin wrapper, 现有功能不变)
Step 3: SessionRegistry + Session 类  『Plan 03』
  ↓
Step 4: Transport + ControlPlane + DataPlane  『Plan 04』
  ↓
Step 5: Frontend 抽象 (TUI/Lark)  『Plan 05』
  ↓
Step 6: EvolutionCore 平级化  『Plan 06』
  ↓
Step 7: Daemon 组装 + 清理 dead code  『Plan 07』
```

---

## 每步验收标准

每个子系统完成后必须:
- `bun run check:all` 全绿
- 所有现有测试仍通过 (thin wrapper 保证向后兼容)
- 新增测试覆盖 ≥ 80%
- knip 无新增 dead code
- ESLint 分层规则无违规

---

## 下一步

从 **Plan 01: Shared & Config** 开始实施, 这是所有后续子系统的基础.
