# ADR 0006: Loop 粒度写锁、原子预算、并发池 — MVP 不做

## 状态

Accepted

## 上下文

PRD 对这三个设计约束要求"P0 必做"：

1. **Loop 粒度写锁**：串行化 cron/manual/review 三入口对 STATE.md 的写入
2. **原子预算计数**：per-loop token 计数走带锁/CAS，不落 STATE.md
3. **AgentSession 并发池**：`maxParallelFindings` + 进程级池，防多-finding Loop 打满进程

M4 是 MVP 最后一棒：cron 触发 loopStep()、fireLoop() 自管 retry/timeout。上述三件事的触发条件在 M4 都还不成立：

- **写锁**：M4 只有 cron 一条入口（手动触发/POST review 在 M5）。`inFlight` 锁已保证 cron 不重叠。
- **预算计数**：M4 用硬编码 model name，没有真实 LLM 调用——token 消耗为 0。预算需要在真实 model 接线后（M5 LOOP.md 落地）才有意义。
- **并发池**：`loopStep()` 只处理一个 fixing item（串行）。M4 不引入并发。

## 决策

**三项全部移出 MVP。** M5 统一评估落地时机。

## 后果

- M4 不新增锁、计数器、池
- LOOP.md + 真实 model 接线后（M5），预算计数随预算保护一同落地
- 手动触发/review API 落地后（M5），写锁随三条入口一同落地
- 并发池在 loopStep() 支持多 item 后评估必要性

## 关联

- [ADR 0001](../adr/0001-loop-prune-is-post-processing.md)
- [CronJob 单飞锁](../architecture/foundations/cron-job.md)
