/** Chinese for the Requirements page family: the list, the goal page, the new-goal and edit
 *  sheet, and the proposals inbox. Keys are the English strings the components call `t()`
 *  with. The integrator merges this dictionary into `zh.ts`. */

export const requirementsZh: Record<string, string> = {
  "Keep the goal, its execution and its decisions apart. A goal holds its scope and acceptance; a proposal holds one separate decision.":
    "把目标、执行和决定分开看。目标保存范围与验收条件；提案保存一次独立的决定。",
  "New requirement": "新建需求",
  "A clear brief, a clear finish": "简报清楚，完成才清楚",
  "Say what done means before anyone runs.": "先把“要做到什么”写清楚。",
  "Finishing a goal never finishes a run, accepts delivery or approves a tool action.":
    "结束目标不会替你结束运行、接受交付或批准工具动作。",
  Goals: "目标",
  "In progress": "推进中",
  "Proposals to decide": "待决定的提案",
  "to decide": "条待决定",
  "Search goals, projects or owners": "搜索目标、项目或负责人",
  "Search goal, project or owner…": "搜索目标、项目或负责人…",
  "All statuses": "所有状态",
  "Filter by status": "按目标状态筛选",
  "All projects": "所有项目",
  "Filter by project": "按项目筛选",
  "{n} of {total} goals": "{total} 个目标中的 {n} 个",
  "No goals tracked yet": "还没有跟踪中的目标",
  "No goal matches": "没有匹配的目标",
  "Goals appear when the PA starts tracking one. State a new goal to your PA.":
    "PA 开始跟踪目标后，目标才会出现在这里。可以向你的 PA 提出一个新目标。",
  "Not linked": "未关联",
  "Not recorded": "未记录",
  "{n} Agent": "{n} 个成员",
  "{n} Agents": "{n} 个成员",
  "{pa} PA · {workers} Worker": "{pa} PA · {workers} Worker",
  "No conversation": "没有关联会话",
  "{n} run(s)": "{n} 次运行",
  "Agents are counted once each by id: the owner and whoever executed the goal's runs. Goal status, run result, tool authorization and human acceptance are four different things.":
    "成员按 ID 去重计数：负责人，以及执行过该目标运行的人。目标状态、运行结果、工具授权和人工验收是四件不同的事。",
  "This goal does not exist or cannot be read.": "这个目标不存在，或者无法读取。",
  "No project linked": "未关联项目",
  "not recorded": "未记录",
  "Cancel this goal?": "取消这个目标？",
  "Cancel goal": "取消目标",
  "Mark this goal done?": "把这个目标标记为完成？",
  "Workbench links only locate a terminal that already exists. When a member has none, the coding page says so and offers a separate Create button; no link here opens a terminal by itself.":
    "工作台链接只定位已有的终端。成员没有终端时，Coding 页会说明，并另给一个“创建终端”按钮；这里的链接都不会自己打开终端。",
  "Workbench: locate this member's terminal. It only focuses one that exists; nothing here opens a terminal.":
    "工作台：定位该成员的终端。它只聚焦已有的终端；这里不会打开终端。",
  "All goals": "所有目标",
  Worker: "Worker",
  Owner: "负责人",
  "Edit goal": "编辑目标",
  Overview: "概览",
  Requests: "请求",
  Brief: "工作简报",
  Goal: "目标",
  Background: "背景",
  Constraints: "约束",
  "Expected deliverables": "预期交付物",
  "Acceptance criteria": "验收条件",
  "Goal status": "目标状态",
  "No conversation is linked. Saving a goal does not run anything.":
    "没有关联会话。保存目标不会触发任何执行。",
  Boundaries: "目标边界",
  "The goal holds the scope and the acceptance. Its status is derived from runs and requests; these two buttons are the person's own decision and change only the stored status.":
    "目标保存范围与验收条件。它的状态由运行和请求推导；下面两个按钮是你本人的决定，只修改目标的存储状态。",
  "Finishing or cancelling changes only this goal. Conversations, run records, results and approvals stay as they are.":
    "结束或取消只改动这一条目标。会话、运行记录、结果和审批都保持原样。",
  "Open conversation": "打开会话",
  "Finish goal": "结束目标",
  "This goal was already decided on": "这个目标已经有过决定",
  "This goal has no project yet. The project link is set by the assistant, not from this page.":
    "这个目标暂未关联项目。项目关联由助理设置，不在本页修改。",
  "No dispatch linked yet": "还没有关联的派单",
  "A run is linked to this goal when the assistant dispatches work for it. Nothing here was started by opening this page.":
    "助理为这个目标派单后，运行才会关联到这里。打开本页不会启动任何运行。",
  Verification: "校验结果",
  Dispatcher: "派单方",
  "Nothing waiting on you": "没有等你处理的请求",
  "Requests raised by this goal's runs appear here until they are answered.":
    "这个目标的运行提出的请求，在得到回答前会显示在这里。",
  "Not available": "未提供",
  "Artifacts are not linked to a goal: the product keeps no such relation, so none can be listed here. Artifacts are on the Artifacts page.":
    "产物没有与目标关联：产品里没有这层关系，所以这里列不出来。产物请到“产物”页查看。",
  "My correction": "我的修改",
  "Goal updated": "目标已更新",
  "Draft a correction": "起草修改请求",
  "Put brief into the conversation": "把简报放进会话",
  "Ask the PA about this goal": "向 PA 询问这个目标",
  "State the goal; the PA tracks it": "说出目标，由 PA 跟踪",
  "Nothing is saved from this sheet. The goal exists once the PA tracks it.":
    "这个侧栏不会保存任何内容。PA 跟踪后，目标才存在。",
  "A goal is tracked by your PA, not created by a form.": "目标由你的 PA 跟踪，而不是用表单创建。",
  "Not editable here: the goal's endpoint takes no project field.":
    "这里不能修改：目标的接口不接受项目字段。",
  Title: "标题",
  "What done looks like.": "做到什么算完成。",
  "What must not be done, and the limits.": "哪些事不能做，范围和限制是什么。",
  "How to tell the goal was reached.": "如何判断达到了目标。",
  "Saving writes the fields you changed. The status, the runs and the acceptance record stay as they are.":
    "保存只写入你改过的字段。状态、运行和验收记录保持不变。",
  "Goals are not created from a form. State the goal to your PA in the conversation; it tracks the goal with its requirement_track tool, and the goal then appears in the list.":
    "目标不是用表单创建的。请在会话里把目标告诉你的 PA；它会用 requirement_track 工具跟踪这个目标，目标随后出现在列表中。",
  "Tracked by the PA while this sheet was open": "这个侧栏打开期间，PA 新跟踪的目标",
  "What done looks like. The PA needs this line.": "做到什么算完成。PA 需要这一行。",
  "Optional. Leave it empty and the PA names the goal.": "可选。留空时由 PA 为目标命名。",
  "The brief only fills the conversation's input. Nothing is sent or saved until you send the message.":
    "简报只会填进会话的输入框。在你发送消息之前，不会发送或保存任何内容。",
  "Adopting from here would write the agent at once. Review the suggestion in the agent editor; applying it there only fills the form.":
    "在这里采纳会立即写入成员配置。请到成员编辑页审阅这条建议；在那里应用只会把建议填进表单。",
  "The inbox cannot apply a workflow proposal. It loads in the workflow editor as an unsaved draft; save there to apply it.":
    "收件箱无法应用流程提案。它会作为未保存的草稿载入流程编辑器；在那里保存才会应用。",
  "Adopting applies the proposal now.": "采纳会立即应用这份提案。",
  "Adopt and apply this proposal?": "采纳并立即应用这份提案？",
  "Adopting applies the proposed values now. It cannot be undone from here.":
    "采纳会立即写入提案中的值，在这里无法撤销。",
  "Discard this proposal?": "丢弃这份提案？",
  "The suggestion is dropped. Nothing it proposed is applied.":
    "这条建议会被丢弃，不会应用其中任何内容。",
  "Nothing waiting for a decision": "没有等你决定的提案",
  "Suggestions the PA files for an agent, a workflow or a project appear here until you adopt or discard them.":
    "PA 为成员、流程或项目提交的建议会显示在这里，直到你采纳或丢弃。",
  "A proposal is a decision waiting for you. Viewing it changes nothing; adopt applies it, discard drops it.":
    "提案是一个等你做出的决定。查看不会改动任何东西；采纳会应用它，丢弃会扔掉它。",
  "Waiting for a decision": "等你决定",
  About: "对象",
  "Open in agent editor": "在成员编辑页中打开",
  "Open in workflow editor": "在流程编辑器中打开",
  "View projects": "查看项目",
  "No worker ran for this goal. An owner, or a discovered candidate, does not mean a worker executed anything.":
    "还没有 Worker 为这个目标执行过。有负责人或发现候选，不代表有 Worker 执行。",
  "No agent relation can be proven for these runs, so no line is drawn: a dispatch edge is never inferred.":
    "这些运行无法证明任何成员关系，所以不画连线：派单关系从不推断。",
  "Participating agents and their recorded relations": "参与成员及其有记录的关系",
  "Participating agents": "参与成员",
  "Counted once by agent id: the count of agents is not the count of runs. Only the owner and the recorded dispatches are read; nothing is filled in from project members.":
    "成员按 ID 去重；成员数不等于运行次数。只读取负责人和有记录的派单，不从项目成员补齐。",
  "No agent is recorded for this goal: nobody tracked it and no run names it.":
    "这个目标没有任何成员记录：没有人跟踪它，也没有运行指向它。",
  dispatched: "派单",
  "Not in the registry": "不在成员列表中",
  "No run of its own for this goal": "没有为这个目标执行运行",
  "{n} run(s) for this goal": "为这个目标运行 {n} 次",
  "Recorded agent relations": "有记录的成员关系",
  "Discovered candidates: Not available. The product records no discovered workers for a goal, so none are listed.":
    "发现候选：未提供。产品不为目标记录发现的 Worker，所以这里没有可列出的内容。",
  "dispatcher not loaded": "派单记录加载中",
  "no dispatcher recorded": "未记录派单方",
  "Puts a request into the input, for you to edit and send": "把一条请求放进输入框，由你编辑后发送",
  "Start a session with this PA to ask about it.": "和这位 PA 新建一个会话，就可以询问它。",
  "Not available: the PA session could not be started.": "未提供：无法启动 PA 会话。",
  "Opening the PA session…": "正在打开 PA 会话……",
  "Adopted and applied.": "已采纳并应用。",
  "Could not adopt": "无法采纳",
  "Unknown error": "未知错误",
  "Discarded.": "已丢弃。",
  "Could not discard": "无法丢弃",
  "Could not update the requirement": "无法更新需求",
  "Waiting for you": "等你决定",
  "Ready for acceptance": "待验收",
  "Agent config": "成员配置",
  "Workflow definition": "流程定义",
  "Project change": "项目修改",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  "timed out": "已超时",
  "waiting for a person": "等待人处理",
  running: "运行中",
  "commit failed": "提交失败",
  "Requirement · Goals & proposals": "需求 · 目标与提案",
  "{n} linked artifact(s)": "共 {n} 个关联产物",
  "No artifacts linked yet": "暂未关联产物",
  "Files produced by runs or workflow executions under this goal appear here automatically.":
    "该目标名下的运行或流程执行产出的文件会自动汇总在这里。",
  "Linked workflow executions": "关联的流程执行",
};
