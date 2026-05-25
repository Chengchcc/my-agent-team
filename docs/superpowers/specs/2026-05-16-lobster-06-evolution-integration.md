# Lobster Spec 06: Evolution Integration

**版本**: v1.0  
**对应 PRD**: §10 Evolution 子系统  
**依赖**: Spec 02, Spec 04  

---

## 1. 需求概述

把现有 Evolution 子系统从嵌入 runtime 抽离为顶层平级的 EvolutionCore，适配新的 trace 路径、event bus、和 control plane API。不修改 review 算法逻辑，只做架构适配。

---

## 2. 模块范围

```
src/evolution/
├── evolution-core.ts      # 新增：顶层平级核心类
├── cursor-store.ts        # 新增：trace review cursor 持久化
├── review-agent.ts        # 现有：适配新路径
├── skill-analyzer.ts      # 现有：适配新路径
├── persistent-queue.ts    # 现有：适配 profile 路径
├── drainer.ts             # 现有：适配
├── triggers.ts            # 现有：改为订阅 EventBus
├── cron-scheduler.ts      # 现有：保持
├── idle-gate.ts           # 现有：保持
├── review-slot.ts         # 现有：保持
├── review-backoff.ts      # 现有：保持
├── circuit-breaker.ts     # 现有：保持
├── supervisor.ts          # 现有：保持
├── settle-bus.ts          # 现有：合并入 EventBus
└── types.ts               # 现有：扩展
```

---

## 3. 详细设计

### 3.1 EvolutionCore (顶层平级)

```ts
export class EvolutionCore {
  private agentCore: AgentCore
  private cursorStore: CursorStore
  private queue: PersistentQueue
  private drainer: Drainer
  private triggers: TriggerManager
  
  readonly enabled: boolean
  
  constructor(agentCore: AgentCore, config: EvolutionConfig)
  
  async start(): Promise<void>
  async stop(graceful?: boolean): Promise<void>
  async flush(): Promise<void>
  
  getProgress(): EvolutionProgress
  async forceReview(opts?: { sinceCursor?: string }): Promise<void>
  
  async acceptPendingSkill(id: Ulid): Promise<void>
  async rejectPendingSkill(id: Ulid, reason?: string): Promise<void>
}
```

**Daemon 组装顺序**:
```
1. AgentCore 初始化完成
2. EvolutionCore 初始化 (引用 AgentCore)
3. 两者平级，无父子关系
```

### 3.2 CursorStore

```ts
// 路径: data/profiles/<id>/evolution/cursor.json

export class CursorStore {
  private path: string
  
  // 单调递增 cursor，指向最后已 review 的 trace
  get lastCursor(): string | undefined
  async advance(newCursor: string): Promise<void>  // 原子写入
  
  // 启动时回填未读 trace
  async backfill(): Promise<TraceFile[]>
}
```

**EV-I3 保证**: cursor 只能前进，不能后退

### 3.3 路径适配

**Evolution 写入路径**:
```
data/profiles/<id>/
├── evolution/
│   ├── cursor.json              # review 进度
│   ├── pending-skills/         # 待确认技能
│   │   ├── <ulid>.json
│   │   └── ...
│   └── queue/                  # 持久化队列
│       ├── tier0/
│       ├── tier2/
│       └── tier3/
└── trace/
    └── <sessionId>/
        └── <traceId>.jsonl     # EV-I1: 只读！
```

### 3.4 EventBus 集成

**订阅的事件**:
```ts
// 触发 review
agentCore.events.on('turn:completed', () => {
  triggers.checkIdle()
})

agentCore.events.on('system:idle', () => {
  triggers.onIdle()
})

// review 结果
drainer.on('skill:proposed', (skill) => {
  agentCore.events.emit('evolution:skillProposed', {
    id: skill.id,
    name: skill.name,
    summary: skill.summary,
  })
})

drainer.on('progress', (progress) => {
  agentCore.events.emit('evolution:progress', progress)
})
```

### 3.5 ControlPlane API 实现

```ts
// transport/control-plane/methods/evolution.ts

export const evolutionMethods = {
  'evolution.status': (params) => {
    return evolutionCore.getProgress()
  },
  
  'evolution.forceReview': async (params) => {
    await evolutionCore.forceReview(params)
    return { scheduled: true }
  },
  
  'evolution.acceptPendingSkill': async ({ id }) => {
    await evolutionCore.acceptPendingSkill(id)
    // 触发 skills.reload('profile')
    agentCore.events.emit('skills:reloaded', { ... })
    return { ok: true }
  },
  
  'evolution.rejectPendingSkill': async ({ id, reason }) => {
    await evolutionCore.rejectPendingSkill(id, reason)
    return { ok: true }
  },
}
```

### 3.6 故障隔离

```ts
// Evolution crash 不影响 AgentCore
try {
  await drainer.drain()
} catch (err) {
  logger.error('Evolution drain failed', { error: err })
  // 只记录，不抛异常，不影响 daemon
}
```

---

## 4. 验收标准

- [ ] daemon 重启后 cursor 从断点继续，不重复消费旧 trace
- [ ] profile A / B 并行运行，evolution 状态物理隔离
- [ ] acceptPendingSkill → skills.reload → 下 turn subTools 包含新 skill
- [ ] evolution 子系统 crash，daemon 主体和其他 session 正常运行
- [ ] forceReview 手动触发正常工作
- [ ] evolution.progress 事件周期发射
- [ ] cursor 原子写入，并发不损坏

---

## 5. 不变量 (EV-I 系列)

- EV-I1: Evolution 只读 trace，绝不修改
- EV-I2: 写入仅限 memory / profile-skills / nudge，不影响其他
- EV-I3: cursor 单调前进，不回退
- EV-I4: review 绝不阻塞 AgentCore turn 执行
- EV-I5: profile 完全隔离
- EV-I6: pending skill 必须用户确认才能生效
- EV-I7: graceful shutdown 保证 cursor 不丢
