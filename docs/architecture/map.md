# 跨页架构地图

这张地图把各页之间的依赖关系画出来，方便从任意一页快速跳到它的上下游。

## 核心事实图

```mermaid
flowchart LR
  SO[system-overview] --> FP[foundations/facts-and-projections]
  FP --> Ledger[conversation/ledger]
  FP --> EL[backend/event-log]
  RS[backend/run-supervisor] -->|onRunMessage 直写| Ledger
  RS -->|非消息事件| EL
  CP[backend/conversation-projection] -.best-effort 扇出.-> Ledger
  Ledger --> Web[surfaces/web]
  Ledger --> Lark[surfaces/lark-adapter]
```

## 执行图

```mermaid
flowchart LR
  RS[backend/run-supervisor] --> RP[runner/runner-protocol]
  RP --> RR[runner/resident-runner]
  RR --> FW[runtime/framework]
  FW --> PL[runtime/plugin]
  PL --> HN[harness/harness]
  FW --> AFS[runner/agent-file-system]
  RS --> EL[backend/event-log]
```

## Web 路径

`flows/e2e-web-message` → `surfaces/web` → `conversation/ledger` → `backend/run-supervisor`（`onRunMessage` 直写账本）→ `runner/resident-runner`；非消息事件旁路进 `backend/event-log`，`backend/conversation-projection` 仅做 best-effort 扇出。

## 飞书路径

`flows/e2e-lark-message` → `surfaces/lark-adapter` → `conversation/conversation-and-members` → `backend/run-supervisor` → `backend/conversation-projection`。

## 排障路径

`operations/troubleshooting` 把症状指回正确的事实层：账本、事件日志、会话投影、Runner、Web 草稿或飞书投递。

## 协作设计图（status: design）

下面两页是**已锁定但尚未进代码**的设计抽象，与现状页区分阅读。

```mermaid
flowchart LR
  Issue[foundations/issue] -->|按 status 分组的视图| Kanban[Kanban 看板]
  Issue -->|projectId 归属| Project[Project = git 子目录]
  Orch[backend/orchestrator] -->|固定转移表 + status 回填| Issue
  Orch -->|复用起运行| RS[backend/run-supervisor]
  Flow[flows/e2e-issue-lifecycle] -.串起时间线.-> Orch
```

`foundations/issue`（唯一新增本体）→ `backend/orchestrator`（驱动状态机的编排器）→ `backend/run-supervisor`（复用执行层）；`flows/e2e-issue-lifecycle` 把这条链路串成跨多次运行的时间线。
