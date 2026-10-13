import type { WorkflowNode } from "./types.js";

/** Per-node-instance context. */
export interface NodeContext {
  executionId: string;
  nodeId: string;
  workflowId: string;
}

/** Execution-scoped store, injected into the backend's node runners. It is NOT
 *  reachable inside the sandbox: a script node's default export receives the
 *  merged input record and nothing else (host objects stay out on purpose —
 *  see docs/architecture/workflow.md).
 *  ponytail: get 同步而 set/delete 异步，v1 接受；若脚本重度读 store 再对称化。 */
export interface StoreApi {
  get(key: string): unknown;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Result of running a node. */
export interface NodeRunResult {
  output?: Record<string, unknown>;
}

/** Contract implemented by the backend I/O shell (Plan 2).
 *  ponytail: 契约无 timeout/cancel 通道，超时靠 sandbox 的 shell race；需要可取消的长任务时再加。 */
export interface NodeRunner {
  run(
    node: WorkflowNode,
    deps: { input: Record<string, unknown>; store: StoreApi; context: NodeContext },
  ): Promise<NodeRunResult>;
}
