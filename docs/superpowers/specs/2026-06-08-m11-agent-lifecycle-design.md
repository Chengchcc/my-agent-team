# M11 Agent Lifecycle — Design Spec (Grilled)

> 诞生 · 成长 · 消亡 · 守活。四件正交又同源的事，寄生在既有 M9/M10 执行底座上，零新执行模型、零新进程协议、零 schema 变更。

## 一、诞生 Genesis

**机制**：`BOOTSTRAP.md` 引导文件 + 用完即焚。不是新 run mode，没有 draft/active 状态机。

**流转**：
```
create → materializeWorkspace 空 ws → 落 BOOTSTRAP.md
  → 首次 run: bootstrap() 见 BOOTSTRAP.md → return boot 作为 systemPrompt
  → agent 对话引导 → 写 SOUL.md(+USER.md) → rm BOOTSTRAP.md
  → 下次 run: BOOTSTRAP.md 不在 → 走正常 identity 拼装
```

**关键决策**：
- `bootstrap()` 见 BOOTSTRAP.md 直接 `return boot`，不读其他 identity 文件。只替换 systemPrompt 静态段，plugin 注入链不受影响。
- 空 workspace 无 BOOTSTRAP.md 时，`bootstrap()` 不再返回旧 `fallbackSystemPrompt`，改为返回内置 `BOOTSTRAP_TEMPLATE`——即 harness 自身 fallback 即诞生。CLI/backend/任何 surface 自动统一。
- `materializeWorkspace` 在 template copy 后检查 SOUL.md 是否存在，不存在才落 BOOTSTRAP.md。
- 诞生礼最小化：只写 SOUL.md(+USER.md)，不强凑 TOOLS/AGENTS。
- 完成判定 = BOOTSTRAP.md 是否被删除（纯文件系统语义，零状态翻转）。
- 诞生模板内容：反问卷、自然对话、use-case 引导、用完即焚。模板存 `packages/harness/src/templates/BOOTSTRAP.md`，构建时 inline 为 TS 常量导出。

## 二、成长 Growth

**机制**：每次 run 收尾前注入反思指引，agent 用现有 write 工具落盘到 workspace。寄生在 run 尾部，不经 backend。

**流转**：
```
agent.run() loop 正常结束
  → 检查：本轮非诞生模式（BOOTSTRAP.md 在 run 开始时已不在）
  → 注入 reflectionGuidance() 为 input，再起一轮 agent.run()
  → agent 用 write 工具写 memory/{today}.md，必要时 edit SOUL/USER
  → 下次 run bootstrap() 读到新 memory
```

**关键决策**：
- 反思是额外一轮普通 `agent.run()`，事件进 EventLog/SSE（透明可审计）。
- **诞生模式跳过 reflect**。判断标准：run 开始前快照 BOOTSTRAP.md 是否存在。即使诞生轮结束时 agent 已删除它，也跳过本轮 reflect（避免刚写 SOUL/USER 又被 reflect 重复写）。
- `reflectionGuidance()` 只给框架不给具体问题："学到了什么值得记住的 → 写 memory；识别到稳定事实 → edit SOUL/USER 回流。回流时追加/微调，勿覆盖已有核心边界。"
- 成长的落点 = 子进程内、run 结束前、写 workspace 文件。backend `onRunComplete` 只知道 run 结束，不拿反思内容。

## 三、消亡 Removal

**机制**：`DELETE /api/agents/:id?hard=true` → 跨 backend.db + events.db 级联删除 + workspace 物理回收 + 无活跃会话校验。

**级联删除范围**：
- **backend.db**（单事务）：`agents` + `threads`(CASCADE via FK) + `checkpoint_messages` + `checkpoint_interrupts` + `checkpoint_events`（三表无 FK，先收集 threadIds 再逐表删）+ `member` 行（agent_id 匹配）
- **events.db**：该 agent 全部 thread 的 `run` + `attempt` + `event_log` 行
- **workspace**：`purgeWorkspace(agentId)` — rm -rf + 路径越界防护，幂等
- **conversation_ledger 保留**：agent 历史消息保留，sender 成悬空引用由投影层 fallback

**关键决策**：
- 删除顺序：① backend.db（单事务）② events.db ③ purgeWorkspace。接受非原子（R5），events.db 失败留孤儿 run 无害，ws 残留 purgeWorkspace 幂等可重跑。
- 活跃会话校验两层：先查 events.db 持久态（`attempt WHERE ended_at IS NULL`），再查内存态 `activeConversations`。任一命中 → 409。
- 默认无 `?hard` → 退化为 archive 软删（现状行为）。
- SQLite `foreign_keys` 默认 OFF，hardDelete 实现必须显式 `PRAGMA foreign_keys=ON`。

## 四、守活 Liveness

**机制**：backend 运行期 reaper 周期收割卡死的 run + 心跳从 liveness 升级为 progress。

**流转**：
```
reaper(setInterval, 周期 = min(heartbeatTimeoutMs/2, 30s)):
  SELECT attempt JOIN run WHERE ended_at IS NULL
  age = now - heartbeat_at
  if age > heartbeatTimeoutMs(60s):
    kill(pid, 0) 探进程 + 等 stepStallTimeoutMs(300s) 二次确认
    → attempt.ended_at = now, run.status = 'interrupted'
    → append EventLog 终态事件
    → 触发 onRunComplete → 释放 M10 会话锁

心跳(progress):
  agent loop 每完成一次 sink.append() 后 → UPDATE heartbeat_at
  不保留独立兜底定时器（否则退回 liveness 假阳性）
  可选：最小写入节流（距上次 ≥ heartbeatIntervalMs 才真写 DB）
```

**关键决策**：
- `heartbeatTimeoutMs` 默认 60s，`stepStallTimeoutMs` 默认 300s（仅 BackendConfig，不进 AgentSpec）。
- reaper 周期 = `Math.min(heartbeatTimeoutMs/2, 30_000)`。
- 心跳单一来源 = progress（每 append 更新），无条件兜底打卡。
- reaper 是 backend 侧纯读 + 状态收敛，不向 runner 发指令。
- 提取 `reapStaleRuns()` 私有方法，`rediscover()` 和 reaper `setInterval` 共用判死核心（但不共用认领逻辑——认领是 rediscover 专属）。
- reaper append 终态事件需 JOIN run 获取 thread_id。
- `dispose()` 清理 reaper timer。

## 五、不变与边界

- **M9/M10 执行底座零侵入**：EventLog 四铁律 / run-attempt / SSE 投影 / cancel / resume / heartbeat 表结构 / checkpointer / conversation ledger / 两道安全阀，一行不改。
- **诞生/成长不发明执行模型**：不加 run mode、不建状态机。
- **无 schema 变更**：M11 不引入 backend.db / events.db 任何新表/新列。
- **agent-spec 零变更**：`stepStallTimeoutMs` 明确不进 AgentSpec。
- **CLI 用 flag 扩展**：`--rm=<id> --hard`，不改造成子命令 CLI。

## 六、默认值

| 配置项 | 默认值 | 位置 |
|---|---|---|
| `heartbeatTimeoutMs` | 60_000 | BackendConfig |
| `stepStallTimeoutMs` | 300_000 | BackendConfig |
| `reaperIntervalMs` | min(heartbeatTimeoutMs/2, 30_000) | BackendConfig |
| 心跳节流 | heartbeatIntervalMs (5s) | runner entry |
