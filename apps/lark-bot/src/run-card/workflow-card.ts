/** The workflow execution's own card: header states the workflow and its
 *  status, the body lists node progress and (at terminal) the verdict.
 *  Same CardKit skeleton the run cards use (schema 2.0, stable element_ids,
 *  streaming while live) so updateCard can patch in place. Pure: the model
 *  and the renderer are testable without Lark. */
export interface WorkflowCardNode {
  nodeId: string;
  status: string;
}

export interface WorkflowCardState {
  workflowId: string;
  status: string;
  nodes: ReadonlyArray<WorkflowCardNode>;
  outputSummary?: string;
  /** Set while a human node parks the execution: the card then carries
   *  approve/deny buttons that resolve it in place. */
  executionId?: string;
  waitingNodeId?: string;
}

const TEMPLATE_BY_STATUS: Record<string, string> = {
  running: "blue",
  waiting_human: "orange",
  success: "green",
  failure: "red",
};

function nodeMark(status: string): string {
  if (status === "completed") return "✅";
  if (status === "failed") return "❌";
  if (status === "running") return "▶️";
  if (status === "waiting_human") return "❓";
  return "▫️";
}

export function workflowCardModel(state: WorkflowCardState): {
  title: string;
  template: string;
  nodesMd: string;
  verdictMd: string;
} {
  const template = TEMPLATE_BY_STATUS[state.status] ?? "grey";
  const title = `workflow ${state.workflowId} · ${state.status}`;
  const nodesMd =
    state.nodes.length === 0
      ? "_还没跑到节点_"
      : state.nodes.map((n) => `- ${nodeMark(n.status)} ${n.nodeId}`).join("\n");
  const verdict =
    state.status === "success"
      ? "✅ 跑完了"
      : state.status === "failure"
        ? "❌ 失败了"
        : state.status === "waiting_human"
          ? "❓ 在等人工确认（到 Web 处理）"
          : "⏳ 跑着…";
  const verdictMd = state.outputSummary ? `${verdict}\n${state.outputSummary}` : verdict;
  return { title, template, nodesMd, verdictMd };
}

export function renderWorkflowCard(state: WorkflowCardState): Record<string, unknown> {
  const model = workflowCardModel(state);
  const live = state.status === "running" || state.status === "waiting_human";
  const card: {
    schema: string;
    config: Record<string, unknown>;
    header: Record<string, unknown>;
    body: {
      direction: string;
      padding: string;
      vertical_spacing: string;
      elements: Array<Record<string, unknown>>;
    };
  } = {
    schema: "2.0",
    config: {
      ...(live ? { streaming_mode: true } : {}),
      update_multi: true,
      width_mode: "fill",
      enable_forward: false,
    },
    header: {
      title: { tag: "plain_text", content: model.title },
      template: model.template,
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      vertical_spacing: "8px",
      elements: [
        { tag: "markdown", element_id: "wf_nodes", content: model.nodesMd },
        { tag: "markdown", element_id: "wf_verdict", content: model.verdictMd },
      ],
    },
  };
  if (state.status === "waiting_human" && state.executionId && state.waitingNodeId) {
    const base = {
      action: "workflow_human",
      executionId: state.executionId,
      nodeId: state.waitingNodeId,
    };
    card.body.elements.push(
      {
        tag: "button",
        element_id: "wf_approve",
        text: { tag: "plain_text", content: "批准" },
        type: "primary",
        behaviors: [{ type: "callback", value: { ...base, approved: true } }],
      },
      {
        tag: "button",
        element_id: "wf_deny",
        text: { tag: "plain_text", content: "拒绝" },
        type: "danger",
        behaviors: [{ type: "callback", value: { ...base, approved: false } }],
      },
    );
  }
  return card;
}
