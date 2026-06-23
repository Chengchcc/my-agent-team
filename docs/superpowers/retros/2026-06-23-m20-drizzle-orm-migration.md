# M20 Retro — Drizzle ORM 重构

## 完成情况

4 物理库全部从手写 SQL + 手写 migration 账本切换为 drizzle-orm + drizzle-kit baseline：

| 物理库 | 表数 | drizzle 目录 | 状态 |
|---|---|---|---|
| `backend.db` | 9 | `apps/backend/drizzle/backend/` | ✅ |
| `events.db` | 8 | `apps/backend/drizzle/events/` | ✅ |
| `checkpointer.sqlite` | 3 | `packages/framework/drizzle/` | ✅ |
| `bindings.sqlite` | 5 | `apps/lark-bot/drizzle/` | ✅ |

26 张表全部定义，4 套 baseline migration 全部与现状一致。

## 关键决策

### 1. checkpointer 完全独立

grill 阶段确认：`checkpointer.sqlite` 是独立物理库（每 runner 一个），backend.db 里寄生的 `checkpoint_*` 三表是 M17.4 遗留。决定：
- Framework 自带 drizzle schema + config + 迁移目录
- Backend.db baseline **不建** checkpoint_* 表
- `adapter-sqlite.ts:191-192` 两条 DELETE 死代码删除
- `SQLITE_CHECKPOINTER_MIGRATIONS` 常量 + `_migrations` 自建账本删除

### 2. `.returning()` 替代 `.run().changes`

drizzle-orm 0.44 bun-sqlite 有 upstream 类型 bug：`BunSQLiteDatabase` 泛型 `TRunResult = void`，但实际 `PreparedQuery.run()` 返回 `Changes`。调研后确认 0.45.2 仍未修复。

最终采用 drizzle 官方推荐模式：DELETE/UPDATE 用 `.returning().all()` 取回行数，INSERT 用 `.returning({ seq }).get()` 取回自增 ID。完全避开 `TRunResult` 类型问题。

### 3. `BEGIN IMMEDIATE` 保持

thread-projection 的 `db.run("BEGIN IMMEDIATE")` 是显式的，不是 `db.transaction()`。drizzle 事务默认 DEFERRED——直接保留原样，写锁不降级。

### 4. `consumeInterrupt` 原子化

原实现 `SELECT + DELETE` 非原子，顺手用 drizzle transaction 包成原子读删。

### 5. dwelling `casing: "snake_case"`

所有 schema 列名改为 camelCase，drizzle 通过 `casing` 自动推导 snake_case。`$inferSelect` 返回 camelCase 无需名称映射。`toRow` 保留的仅剩类型窄化（boolean ↔ integer、JSON parse、enum validation），下一步可考虑 domain type 窄化消除。

### 6. runtime-ops/listRuns 保留手写 SQL

`WHERE 1=1` 动态 AND + `LIKE ? ESCAPE '\'` + `json_extract`——这些 SQLite 特有函数和动态过滤模式，drizzle query builder 无原生抽象，保留手写最清晰。

## 基线 diff 发现的偏差

- `idx_run_thread` 和 `idx_run_ops_event_kind` 的 DESC 方向：drizzle-kit 生成的索引无 ASC/DESC 声明（SQLite 3.x 无操作，B-tree 可双向遍历）。功能等价，记录备忘。
- lark-bot `run_stream` 16 列（含 `complete_from_ledger`）全部进 baseline，`migrateRunStreamSchema` ALTER hack 删除。

## Schema 偏差修复

- `migrations.ts` 删除（`BACKEND_MIGRATIONS` + `ALL_MIGRATIONS` 无引用）
- `events-db-migrations.ts` 改为 drizzle-kit `migrate()` 调用，`EVENTS_DB_MIGRATIONS` 数组删除
- lark-bot `ensureSchema()` DDL + `migrateRunStreamSchema()` 删除
- framework `tablePrefix` 死代码删除

## 测试

- Backend: 324 pass / 0 fail
- Framework: 116 pass / 0 fail
- Lark-bot bindings: 8 pass / 0 fail (bootstrap 测试预存冲突)
- Web typecheck: 修复 3 个预存 TS 错误（react-query mutate + autoOrchestrate 类型）
