# DB 类型链规则

本页是 backend 内部类型链（drizzle schema → service → http）的动手前决策表与写完自检。它是[设计哲学](./design-philosophy.md)里「统一本体，不复制语义」在 DB 层上的可执行版：加字段、改表、写 service 返回类型、读写 JSON 列、加枚举值之前，先过这张表。

## 范围

覆盖：触发器决策表、真源地图、写完自检、加表加列时的自问、层级图与它和跨进程规则的边界。

不覆盖：backend 与 web、lark-bot 之间的跨进程类型链（见 [跨进程契约规则](./e2e-contract-rules.md)）。

## 一句话根因

drizzle 表定义一旦和 service 层各写一份，编译器就看不见两边的关系：加字段时 service 的手写 interface 不报错，删列时残留的死字段也不报错。`tsc` 通过不是「对」的证据——手写 interface 和真表可以永久分叉。

解法只有一条：`apps/backend/src/infra/db/schema.ts` 是唯一真源，下游类型经 `$inferSelect` / `$inferInsert` 与 drizzle-zod 推导。

## 动手前的决策表

| 当你要…… | 先停，去这里取真源 | 禁止 |
|---|---|---|
| 给表加一个列 | 改 `schema.ts` 的表定义，用 `bash scripts/gen-drizzle.sh` 生成迁移；类型从 `$inferSelect` 自动流到消费者 | 先改 service 的 interface，再回头同步表定义 |
| 读一个 DB 行 | `import { xxxSelectSchema }` 后 `.parse(row)`；类型用 `typeof schema.xxx.$inferSelect` | `row as XxxRow`、手写 `interface XxxRow` |
| 写一个 DB 行 | `xxxInsertSchema.parse(input)` 校验后再写；类型用 `$inferInsert` | 裸 `db.insert().values(input)` 不校验 |
| 在 service 定义返回类型 | 从 `$inferSelect` 推导：`Pick` / `Omit` / 交叉覆写 | 手写 `export interface MyDto { ... }` |
| 在 HTTP handler 返回 JSON | 返回体形状由 service 返回类型决定 | 在 handler 里即兴拼对象 |
| 读写 JSON 列 | 在 `schema.ts` 的 drizzle-zod 里写双向 transform（读 `JSON.parse`、写 `JSON.stringify`）；业务代码经 parse 后直接拿到对象 | 业务代码里 `JSON.parse(row.payload) as T` |
| 读写 int bool 列 | 同上，在 `schema.ts` 写 transform（读 `n !== 0`，写 `? 1 : 0`） | 业务代码里 `!!row.enabled`、`? 1 : 0` |
| 加一个枚举值 | 在共享位置定义 `as const` 或 `z.enum`，两端 import | 在新文件重抄联合类型、裸 `as SomeStatus` |
| 改一个列的类型 | 只改 `schema.ts`，让 typecheck 标出所有下游断裂点 | 改完表手动追着改各层 |

## 生成迁移

迁移由 `bash scripts/gen-drizzle.sh` 生成（`predev.sh` 在 journal 缺失时会调用它），**迁移文件提交进版本库**：CI 跑同一个脚本核对 schema 与迁移是否同步，不同步即红。

手写迁移时必须用带箭头的断点：

```sql
-- statement-breakpoint
```

drizzle 的 `readMigrationFiles` 按这个带箭头的标记切分语句；写成不带箭头的 `-- statement-breakpoint` 时它**不会切分**，而 `bun:sqlite` 的 prepare 只执行第一条，后续语句被静默丢弃，`migrate()` 既不报错也照常记录 hash。历史上就是这样丢过两条语句和一个索引，最后靠 `0039_repair_plain_breakpoint_drops.sql` 幂等补齐。

验证迁移是否真的生效，要直接查 `sqlite_master` 或 `PRAGMA`，不要相信 journal 里的行数。

## 真源地图

| 契约 | 真源 | 消费方式 |
|---|---|---|
| 表形状 | `schema.ts` 的 `sqliteTable(...)` | 生成迁移 |
| Row 读类型 | `typeof schema.xxx.$inferSelect` | `Pick` / `Omit` / 直接用 |
| Row 写类型 | `typeof schema.xxx.$inferInsert` | 直接用 |
| 读校验 | `xxxSelectSchema` | `.parse(row)` |
| 写校验 | `xxxInsertSchema` | `.parse(input)` |
| JSON 列 codec | drizzle-zod 的 transform | 对业务透明 |
| int bool codec | drizzle-zod 的 transform | 对业务透明 |
| 枚举值 | 共享的 `as const` 或 `z.enum` | import |
| 迁移 | `gen-drizzle.sh` 产出 SQL | — |

## 层级图

```text
schema.ts
  sqliteTable(...)            ← 唯一真源
  createSelectSchema(...)     ← JSON 与 int bool 的 transform 在这里
  createInsertSchema(...)
  $inferSelect / $inferInsert ← 类型自动产出
      │
      ▼
feature 的类型文件
  export type FooRow = typeof schema.foo.$inferSelect
  export type FooEvent = Omit<...$inferSelect, "col"> & { col: ParsedType }
      │
      ▼
service / adapter
  返回类型从上面的类型 Pick / Omit
  运行时校验：xxxSelectSchema.parse(row) / xxxInsertSchema.parse(input)
      │
      ▼
http.ts
  handler 返回类型 = service 返回类型，全链推导
```

铁律：数据单向流动 `schema.ts → 类型 → service → http`。让 schema 去适配 service 定义的类型算违规。

## 写完自检

下面几条是人工检查用的，**当前都不干净**——它们描述的是目标态而非现状，命中不等于你引入了新问题，但你要回答「这处为什么没从真源推导」。

```bash
# 手写行类型
grep -rn "interface.*Row\b" apps/backend/src/features/
# 裸 JSON.parse 加断言
grep -rn 'JSON.parse(.*) as [A-Z]' apps/backend/src/features/
# 裸断行类型
grep -rn ' as [A-Z][a-z]*Row\b' apps/backend/src/features/
# 各 feature 重抄字面量联合
grep -rn 'type.*Status.*=.*".*".*".*"' apps/backend/src/features/
# int bool 手动转换
grep -rn '!!.*\.enabled\|.*enabled.*? 1 : 0' apps/backend/src/features/
```

最后一条目前是干净的，其余几条有存量命中：手写行类型散在 agent-context、conversation、agent、mcp、project、settings、knowledge、skill-pack、workflow 里；JSON 列的裸 parse 加断言在 agent-run 的解析适配器与 workflow 适配器里最多；状态联合在 agent-run、knowledge、skill-pack、workflow 各写一份。

跨进程那一侧有 `bun run audit:contracts` 做 CI 门禁，**DB 这一侧还没有对应的可执行门禁**。要收紧的话，方向是把上面几条做成 `scripts/` 下的门禁脚本，而不是继续靠人工 grep。

## 加新表或新列时的自问

1. 它属于哪个已有的表？属于就改表定义；不属于才建新表。
2. 它是读路径还是写路径？读用 Select，写用 Insert。
3. 有 JSON 列吗？有就必须在 `schema.ts` 里加 transform，业务层不许再 parse。
4. 有 int bool 列吗？有就必须在 `schema.ts` 里加 transform，业务层不许再 `!!`。
5. 半年后有人改表结构，编译器会拦住所有下游断裂点吗？拦不住就还没收敛好。

## 与跨进程规则的边界

| 层面 | 规则 | 真源 |
|---|---|---|
| backend 内部（drizzle → service → http） | 本文 | `schema.ts` |
| backend 与 web、lark-bot 之间（HTTP、SSE、env） | [跨进程契约规则](./e2e-contract-rules.md) | Elysia 的 `App` 类型 |

两层互补不重叠。改了 drizzle 列，service 类型自动流到 handler，handler 的返回体进 `App` 类型，web 与 lark-bot 经 treaty 自动感知。
