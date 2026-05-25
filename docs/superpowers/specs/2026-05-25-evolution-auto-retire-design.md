# Evolution Auto-Retire — Tier2 数据驱动自动下架 Design

- **Status**: Draft
- **Author**: Lobster Self-Learning Crew
- **Date**: 2026-05-25
- **Depends on**: `2026-05-25-self-learning-go-live-design.md`(必须先让 review worker 真正写 verdict)
- **Scope**: 当某个 skill 的成功率/取消率/失败率持续低于阈值时,evolution 系统自动把它从 active 目录归档到 `_archived/`,并发出 `skills.reload-requested` 事件让 skills 系统重新加载注册表。

---

## 0. 背景与问题

evolution 系统的 Tier1 review 经 self-learning-go-live spec 接通 LLM 后,可以输出 `verdict ∈ {endorse, refine, retire, inconclusive}`。但当前架构只在 LLM 主动判定 `retire` 时才下架,存在两个盲区:

1. **LLM 倾向保守**:即使一个 skill 连续 10 次失败,只要每次错误模式略有不同,Tier1 LLM 大概率仍判 `inconclusive` 而非 `retire`。
2. **统计信号被忽略**:`StatsCollector` 已经在采集 `successCount / cancelCount / failCount`,但 evolution 流程里没有任何分支真正消费这些数字做硬决策。

本 spec 增加 **Tier2 stats-driven auto-retire**:在 Tier1 LLM 判定之外,引入一个并行的、纯数值规则的"二次审查",当 skill 的近 N 次执行统计跌破阈值时,直接归档,不再请教 LLM。

---

## 1. 设计原则

- **统计规则优先,LLM 兜底**:数值阈值清晰可解释,出问题易回溯;LLM 只在统计样本不足时介入(已由 Tier1 覆盖)。
- **归档不删除**:`skills/active/foo/` → `skills/_archived/foo-<timestamp>/`,文件保留,人工可恢复。
- **双阶段降级**:先 `flag`(标记 + 告警),持续不达标后才 `confirm-retire`(归档),避免单次抖动误杀。
- **不阻塞主流程**:auto-retire 完全在 evolution worker 的回调里跑,失败不影响 review 主链路。

---

## 2. 触发时机

`evolution.review-completed` 事件触发后,在 evolution extension 的 subscriber 里追加一个 stats-driven 分支:

```
review-completed (Tier1 verdict)
       │
       ├── verdict == 'retire'         ──▶ 走原有归档流程
       │
       └── 对所有 verdict 一律执行     ──▶ stats-driven 二次审查
                                             │
                                             ▼
                                       StatsCollector.snapshot(skillName)
                                             │
                                             ▼
                                       evaluateRetireRules(snapshot)
                                             │
                              ┌──────────────┼──────────────┐
                              ▼              ▼              ▼
                          'healthy'      'flag'         'retire'
                          (no-op)        (mark+notify)  (archive)
```

> Tier1 LLM 已经判 retire 的情况直接走原有归档,不重复触发。其余 verdict (endorse / refine / inconclusive) 都会接受统计审查。

---

## 3. 统计阈值规则

`evaluateRetireRules(snapshot)` 是纯函数,签名:

```ts
export interface SkillStatsSnapshot {
  skillName: string
  totalRuns: number          // 全生命周期
  recentRuns: number         // 滑动窗口内(默认 20 次)
  recentSuccess: number
  recentCancel: number
  recentFail: number
  flagged: boolean           // 之前是否已被 flag
  flaggedAt?: number
}

export type RetireDecision =
  | { action: 'healthy' }
  | { action: 'flag', reason: string }
  | { action: 'retire', reason: string }

export function evaluateRetireRules(
  s: SkillStatsSnapshot,
  cfg: AutoRetireConfig,
): RetireDecision
```

判定阶梯:

```
1. recentRuns < cfg.minSampleSize (默认 5)            → healthy(样本不足)
2. (recentSuccess / recentRuns) >= cfg.healthThreshold (0.5)
                                                      → healthy
3. recentSuccess / recentRuns < cfg.flagThreshold (0.3)
   且未 flag                                          → flag
4. recentSuccess / recentRuns < cfg.retireThreshold (0.15)
   或 (flagged 且 now - flaggedAt > cfg.flagGracePeriodMs)
                                                      → retire
5. 其它                                              → healthy
```

关键参数:

```ts
interface AutoRetireConfig {
  minSampleSize: number          // 5
  windowSize: number             // 20    —— StatsCollector 滑窗
  healthThreshold: number        // 0.5   —— 成功率高于此值即健康
  flagThreshold: number          // 0.3   —— 低于此值且未 flag 则 flag
  retireThreshold: number        // 0.15  —— 低于此值立即 retire
  flagGracePeriodMs: number      // 7 * 86400_000 —— flag 后多久仍不达标则 retire
  cancelCountsAsFailure: boolean // true  —— 用户取消是否记作失败
}
```

> `cancelCountsAsFailure=true` 是默认值,因为"用户连续 cancel"通常意味着 skill 输出不符合预期。可配置成 false 以适配纯实验性 skill。

---

## 4. StatsCollector 扩展

`src/extensions/evolution/stats-collector.ts` 当前只有 totalRuns / success / cancel / fail 计数器。新增滑窗:

```ts
class StatsCollector {
  private recent = new Map<string, Array<{ outcome: 'success'|'cancel'|'fail', at: number }>>()

  record(skillName: string, outcome: 'success'|'cancel'|'fail'): void {
    const arr = this.recent.get(skillName) ?? []
    arr.push({ outcome, at: Date.now() })
    if (arr.length > cfg.windowSize) arr.shift()
    this.recent.set(skillName, arr)
  }

  snapshot(skillName: string): SkillStatsSnapshot { ... }
}
```

存储:重启不保留滑窗(简化实现);若需持久化,后续可加 `stats_snapshots` 表。MVP 接受重启清零。

`flagged / flaggedAt` 状态需要持久化,新增 `skill_meta` 表:

```sql
CREATE TABLE IF NOT EXISTS skill_meta (
  skill_name TEXT PRIMARY KEY,
  flagged INTEGER NOT NULL DEFAULT 0,
  flagged_at INTEGER,
  flagged_reason TEXT,
  archived_at INTEGER
);
```

---

## 5. 归档执行

`AutoRetirer` 用例(application 层)负责真正动文件:

```ts
class AutoRetirer {
  constructor(
    private paths: AgentPaths,
    private fs: FileSystem,
    private bus: ContractBus,
    private logger: Logger,
  ) {}

  async retire(skillName: string, reason: string): Promise<void> {
    const src = path.join(this.paths.skills, 'active', skillName)
    const dstName = `${skillName}-${Date.now()}`
    const dst = path.join(this.paths.skills, '_archived', dstName)

    await this.fs.mkdir(path.dirname(dst), { recursive: true })
    await this.fs.rename(src, dst)

    await skillMetaRepo.markArchived(skillName, Date.now())

    this.bus.emit('skill.archived', { skillName, archivedTo: dst, reason })
    this.bus.emit('skills.reload-requested', { source: 'auto-retire', skillName })
    this.logger.info('skill auto-retired', { skillName, reason, archivedTo: dst })
  }
}
```

> `skills.reload-requested` 由 skills extension 订阅(参见 self-learning-go-live spec §Q3),触发其内部 `doReload` 函数。**evolution 不直接调 skills RPC**。

---

## 6. extension 接线

`src/extensions/evolution/index.ts` 的 subscriber 追加:

```ts
subscribe: {
  'evolution.review-completed': async (event) => {
    const { skillName, verdict, runId } = event.payload

    if (verdict === 'retire') return // 走原有归档

    const snapshot = statsCollector.snapshot(skillName)
    const decision = evaluateRetireRules(snapshot, cfg.autoRetire)

    if (decision.action === 'flag') {
      await skillMetaRepo.markFlagged(skillName, decision.reason)
      bus.emit('skill.flagged', { skillName, reason: decision.reason, runId })
      logger.warn('skill flagged for retirement', { skillName, reason: decision.reason })
      return
    }

    if (decision.action === 'retire') {
      await autoRetirer.retire(skillName, decision.reason)
      return
    }
  }
}
```

为防止同一 skill 短时间内被反复触发归档(skills.reload 后又来一波统计),`AutoRetirer.retire` 内部加幂等检查:`if (skillMeta.archivedAt) return`。

---

## 7. 与 Tier1 LLM 的关系

| 场景                                 | 谁先决策                                           |
|--------------------------------------|----------------------------------------------------|
| LLM 判 retire,统计也差              | LLM 优先,走原归档,不再过 §3 规则                   |
| LLM 判 inconclusive,统计差          | 走 §3 stats-driven,可能 flag 或 retire             |
| LLM 判 endorse/refine,统计差        | 走 §3,**统计规则胜出**(LLM 可能被噪声欺骗)        |
| LLM 判 endorse/refine,统计健康      | healthy,无动作                                     |
| 样本不足 (recentRuns < 5)            | healthy,等数据                                     |

设计上**给 stats-driven 最高优先级**:它是确定性、可回溯的兜底。LLM 的优势在 Tier2 refine,Tier1 endorse/retire 的决策权应当交给硬数据。

---

## 8. 可观测性

| 事件名              | payload                                              |
|--------------------|------------------------------------------------------|
| `skill.flagged`    | `{ skillName, reason, snapshot }`                    |
| `skill.archived`   | `{ skillName, archivedTo, reason, snapshot }`        |
| `skill.unflagged`  | `{ skillName }`(成功率回升后清除 flag)              |

`unflag` 逻辑:`evaluateRetireRules` 在 `healthy` 分支额外检查 `if (snapshot.flagged) return { action: 'unflag' }`,subscriber 看到 `unflag` 时清除 `skill_meta.flagged`。

---

## 9. 配置默认值

```ts
// src/config/defaults.ts
evolution: {
  autoRetire: {
    enabled: true,            // 默认开启
    minSampleSize: 5,
    windowSize: 20,
    healthThreshold: 0.5,
    flagThreshold: 0.3,
    retireThreshold: 0.15,
    flagGracePeriodMs: 7 * 86_400_000,
    cancelCountsAsFailure: true,
  }
}
```

---

## 10. 验收清单

- [ ] 一个 skill 连续 20 次 fail,且 LLM Tier1 一直判 inconclusive,在第 20 次之后自动 `flag` → 触发 `skill.flagged` 事件
- [ ] flag 后 7 天内成功率仍 < 0.15,触发 `skill.archived` + 文件从 `active/` 移到 `_archived/`
- [ ] 归档后自动发 `skills.reload-requested`,skills extension 重新加载注册表,被归档 skill 不再出现在 active 列表
- [ ] 同一 skill 已 archived 后再来 review,subscriber 内幂等短路,不会重复 rename
- [ ] 人工恢复 + `skills.reload` 后,skill 重新可用;若再次跌破阈值,会再次走 flag → retire
- [ ] `autoRetire.enabled=true` 时(默认),§6 subscriber 分支正常运行,归档逻辑生效
