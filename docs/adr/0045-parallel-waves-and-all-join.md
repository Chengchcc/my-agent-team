# 0045 波次并行与 all-join

- 状态：Accepted
- 日期：2026-10-19

## 背景

DSL 的拓扑一直能表达并行（一个节点多条出边），`computeNext` 也一直返回一个 ready **列表**；但 drive 循环用 `for … await` 逐个跑，所以「并行分支」实际是串行排队。汇合只有 any-of：一条上游路由到它就开跑，互斥分支因此不会死等未走的那一支。

## 决定

1. **一个 wave 里的 ready 节点并发执行**。结果按 ready 顺序**串行落库**（node_run 更新、冻结路由、返工裁决），让「并发」只影响耗时，不影响任何持久事实的顺序。`order` 也按 ready 顺序分配。
2. 节点可声明 **`join: "any" | "all"`**，默认 `any`。`all` 额外要求**全部上游都已 completed**。
3. **all-join 放在互斥分支上永不触发**：引擎只在波边界看状态，此时未完成的上游就是永远不会完成的（它的分支没被走到）。这是语义，不是缺陷——要「等到所有分支」就不该让上游互斥。

## 不变量

- 路由仍在节点**完成瞬间**冻结进 `routedTo`（ADR 0042），并行不改变这一点。
- wave 内某节点失败：兄弟节点照常落库（它们的 node_run 行就是事实），随后整波失败、execution 落 `failure`。
- human 节点在 wave 里 park：同波兄弟照常落库，execution 落 `waiting_human`，drive 返回；回答后重入 drive。
- any-of 的既有语义不变。

## 代价与边界

- **波次屏障**：快分支要等最慢的兄弟，后继才在下一波开始（不是 completion-driven 调度）。升级路径写在 `service.ts` 的 `ponytail:` 注释里：按 completion 队列 + 逐节点就绪判定。
- 同一工作区的 agent 节点仍会被 workspace lock 串行——这是正确性优先，并行只对不同工作区/脚本节点立刻生效。
