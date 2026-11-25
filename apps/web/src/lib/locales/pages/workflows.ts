/** The workflow pages: the list, the saved overview, the editor and its panels, the run dialog. */

export const workflowsZh: Record<string, string> = {
  // Shared words of these pages
  "All workflows": "全部流程",
  "New workflow": "新建流程",
  "Edit workflow": "编辑流程",
  Editor: "编辑器",
  "Editor mode": "编辑模式",
  Canvas: "画布",
  DSL: "DSL",
  "Node inspector": "节点字段",
  Inspector: "节点面板",
  Properties: "属性",
  Nodes: "节点",
  Triggers: "触发方式",
  Trigger: "触发方式",
  "{id} · Saved overview": "{id} · 已保存概览",
  "{id} · Workflow": "{id} · 流程",
  Execution: "执行记录",
  "Last run": "最近一次执行",
  "Next run": "下次运行",
  "Started by": "启动来源",
  "Run in flight": "有执行在进行",
  "Never run": "尚未运行",
  "Runs when started": "启动时运行",
  Manual: "手动触发",
  API: "API",
  Webhook: "Webhook",
  Cron: "Cron 表达式",
  "Schedule · on": "定时 · 已开启",
  "Schedule · off": "定时 · 未开启",
  "Saved trigger": "已保存的触发方式",
  "Schedule state": "定时的状态",
  "Not scheduled": "未定时",
  "No schedule saved": "没有保存定时",
  "No schedule is saved.": "没有保存定时。",
  "No schedule is saved. The workflow runs when started.": "没有保存定时。流程在启动时运行。",
  "Saved schedules": "已保存的定时",
  "Next run {when}": "下次运行：{when}",
  "Not computable": "无法计算",
  On: "开",
  Off: "关",
  Add: "添加",
  Remove: "移除",
  Description: "描述",
  "Optional.": "可选。",
  nodes: "节点",
  edges: "边",
  forward: "前进",
  rework: "返工",
  "No condition": "无条件",
  "at most {attempts} attempt(s), then {outcome}": "最多 {attempts} 次，超限后 {outcome}",
  Saved: "已保存",
  "Unsaved changes": "有未保存的修改",
  Validate: "校验",
  "Valid definition": "定义有效",
  "Invalid definition": "定义无效",
  Undo: "撤销",
  Redo: "重做",
  "Saving…": "保存中…",
  "Workflow saved": "流程已保存",
  "Save failed": "保存失败",
  "Workflow deleted": "流程已删除",
  "Could not delete the workflow": "无法删除流程",
  Retry: "重试",
  Leave: "离开",
  Stay: "留下",
  session: "会话",

  // List
  "Understand a flow and its last runs before opening it. Only Edit workflow opens the editor.":
    "先了解流程与最近执行，再进入详情。只有点“编辑流程”才会打开编辑器。",
  "Workflows: {count}": "流程：{count}",
  "Executions: {count}": "执行记录：{count}",
  "{nodes} nodes · {edges} edges · {runs} executions": "{nodes} 节点 · {edges} 边 · {runs} 实例",
  "{nodes} nodes · {edges} edges · script nodes: {scripts}":
    "{nodes} 节点 · {edges} 边 · 脚本节点：{scripts}",
  "No description yet": "尚未填写说明",
  "View overview and runs": "查看概览与执行记录",
  "No workflows yet": "还没有流程",
  "Create one from a blank graph or a copy of an existing workflow. Nothing runs until you start it.":
    "可以从空白的图开始，也可以复制一个已有流程。在你启动之前什么都不会运行。",
  "The workflows could not be read.": "无法读取流程列表。",
  "The definition could not be read": "无法读取定义",
  "The definition could not be read.": "无法读取定义。",
  "This definition does not parse. Open the editor to see why.":
    "这份定义解析不通过。打开编辑器查看原因。",
  'Delete workflow "{name}"?': "删除流程「{name}」？",
  "Its definition file is removed and its schedule stops. Past executions stay. This cannot be undone.":
    "定义文件会被删除，定时也会停止。过去的执行记录保留。此操作无法撤销。",
  "Saved {time}": "保存于 {time}",

  // New workflow sheet
  "A draft with a start and an end. The rest is built in the editor.":
    "一份有起点和终点的草稿，其余在编辑器里搭建。",
  "Workflow name": "流程名称",
  "Workflow ID": "流程 ID",
  "The name needs a letter or a number.": "名称至少需要一个字母或数字。",
  "A workflow with this id exists. Choose another name.": "已存在这个 ID 的流程，请换一个名称。",
  "e.g. Release verification": "例如：发布验证",
  "A copy takes the graph only: not the runs, and no schedule.":
    "副本只带走图：不带执行记录，也不带定时。",
  "Blank graph (start → end)": "空白 DAG（start → end）",
  "Copy of {name}": "{name} 的副本",
  "The workflow exists when you press Create, as a draft without a schedule. The PA beside it only advises, through messages you send.":
    "点“创建”后流程才存在，是一份没有定时的草稿。旁边的 PA 只给建议，而且只通过你发出的消息。",
  "Nothing is created until you press Create.": "点“创建”之前不会创建任何东西。",
  "Create workflow": "创建流程",
  "Creating…": "创建中……",
  "Could not create the workflow": "无法创建流程",
  "Describe the workflow; the PA advises": "描述这个流程，PA 来提建议",

  // Run dialog
  "Run {name}": "运行 {name}",
  "Starts one execution of the saved definition. Nothing is saved or enabled by it.":
    "对已保存的定义启动一次执行。它不会保存或启用任何东西。",
  "Loading the definition…": "正在读取定义……",
  "true / false": "true / false",
  "This definition does not parse, so the server will not run it. Open the editor to fix it.":
    "这份定义解析不通过，服务器不会运行它。打开编辑器修复。",
  "A run of this workflow is still going. The server refuses a second one until it ends.":
    "这个流程有一次执行还在进行。在它结束之前，服务器拒绝再启动一次。",
  "Execution started": "已开始执行",
  "Execution deleted": "执行记录已删除",
  "Delete execution {id}?": "删除执行记录 {id}？",
  "The record of this run is removed. This cannot be undone.":
    "这次运行的记录会被删除。此操作无法撤销。",
  "Delete failed": "删除失败",
  "The executions could not be read.": "无法读取执行记录。",
  "A run waiting for a person needs an answer on its own page. Deleting a run removes its record; the definition is not touched.":
    "等待人工回答的执行要在它自己的页面上作答。删除运行只移除它的记录，不影响定义。",

  // Saved overview
  "This workflow does not exist or cannot be read.": "这个流程不存在或无法读取。",
  "This execution does not exist or cannot be read.": "这条执行记录不存在或无法读取。",
  "This file is not a workflow definition: it has no list of nodes and edges. The DSL tab shows it as it was read.":
    "这个文件不是流程定义：没有节点和边的列表。DSL 标签页显示读到的原文。",
  "The saved definition does not parse. The server will not run or schedule it.":
    "已保存的定义解析不通过。服务器不会运行它，也不会给它定时。",
  "Runs when started from this page or through the API.": "从本页或经 API 启动时运行。",
  "A schedule is saved with the definition, in the editor.": "定时随定义保存，在编辑器里设置。",
  "The next run is computed in this browser's time; the server's clock runs the schedule.":
    "下次运行按本浏览器时区计算；实际按服务器的时钟执行。",
  "Saved definition": "已保存的定义",
  "Each execution keeps the definition it started with.": "每次执行保留它启动时的定义。",
  "Saved definition · read only": "已保存的定义 · 只读",
  "View JSON": "查看 JSON 定义",
  "DAG · saved": "DAG · 已保存",
  "The graph could not be drawn from this definition.": "无法根据这份定义画出图。",
  "Node {id} · saved properties": "节点 {id} · 已保存的属性",
  "Conditions, joins and rework budgets": "查看条件路由、汇合与返工预算",
  "Clicking a node only shows its saved properties. To change a node, an edge or the trigger, open the editor; past executions keep the definition they started with.":
    "点击节点只查看已保存的属性。要改节点、边或触发方式，请进入编辑器；历史执行不受影响，它们保留启动时的定义。",
  "Ways to start": "启动方式",
  Way: "方式",
  How: "做法",
  "Run on this page starts one execution with the inputs you give.":
    "在本页点运行，按你给的输入启动一次执行。",
  "with the workflow file and the input; no declaration needed.":
    "带上流程文件和输入；不需要额外声明。",
  "with the workflow's trigger token. This page does not issue the token.":
    "带上这个流程的触发令牌。本页不签发令牌。",
  "A cron expression saved with the definition, while it is on. After three failed runs in a row the scheduler stops firing it until a run succeeds.":
    "随定义保存的 cron 表达式，开启时生效。连续三次失败后调度器会停止触发，直到有一次运行成功。",
  "Turning a schedule on or off, or changing it, is an edit: it is saved with the definition in the editor, never from this page.":
    "开关或修改定时是一次编辑：它随定义在编辑器里保存，不会从本页写入。",
  "Definition as saved": "已保存的定义（JSON）",
  "Changing this text changes nothing here. Open the editor to edit the definition as JSON.":
    "在这里改文字不会有任何作用。要在编辑器里以 JSON 编辑定义。",

  // Editor
  "Canvas ↔ node fields ↔ PA suggestions. A suggestion becomes an unsaved draft; Save is what writes.":
    "画布 ↔ 节点字段 ↔ PA 建议。建议只变成未保存的草稿，保存才会写入。",
  "Select a node or an edge to edit it, or open Nodes to add one.":
    "点一个节点或一条边来编辑，或打开“节点”添加。",
  "This file is not a workflow definition, so there is nothing to edit here.":
    "这个文件不是流程定义，这里没有可编辑的内容。",
  "You have unsaved modifications. Leaving will lose them.": "你有未保存的修改，离开会丢失它们。",
  "PA proposal waiting": "有 PA 提案待查看",
  "Load the proposal": "载入提案",
  "The PA's pending proposal says what is already saved. There is nothing to load.":
    "PA 的待处理提案与已保存的内容一致，没有需要载入的。",
  "A proposal from the PA is on the canvas as an unsaved draft. Save keeps it; Undo brings the saved definition back.":
    "PA 的一条提案已作为未保存的草稿放在画布上。保存即保留；撤销会回到已保存的定义。",
  "A proposal from the PA is waiting. It is not on the canvas yet.":
    "PA 有一条提案待处理，还没有放到画布上。",
  "A proposal from the PA is waiting. Your unsaved edits come first; loading it replaces them, and Undo brings them back.":
    "PA 有一条提案待处理。你的未保存修改优先；载入会替换它们，撤销可以找回。",
  "Saving settles a proposal that is on the canvas: adopted when what you saved is that proposal, discarded when you changed it first. One that was never loaded stays pending until it is discarded from the Proposals inbox.":
    "保存会结清画布上的那条提案：存下的就是它，记为采纳；你先改过，记为丢弃。没有载入过的提案仍待处理，直到在“提案”收件箱里被丢弃。",
  "The proposal was recorded as adopted: the saved definition is that proposal.":
    "这条提案已记录为采纳：保存的定义就是它。",
  "The proposal was recorded as discarded: the saved definition differs from it.":
    "这条提案已记录为丢弃：保存的定义与它不同。",
  "Ask the PA to change this workflow": "请 PA 修改这个流程",
  "Workflow DSL": "流程 DSL",
  "Apply puts the text on the canvas as an unsaved change. Save, in the toolbar, is what writes it.":
    "“应用到画布”把文本作为未保存的改动放到画布上。写入靠工具栏的保存。",
  "Loading editor…": "正在加载编辑器……",
  "Apply to canvas": "应用到画布",
  "Applied to the canvas. Save writes it.": "已应用到画布。点保存才会写入。",
  "Invalid DSL": "DSL 无效",

  // Trigger panel
  "Add a schedule (one at most)": "添加定时（最多一个）",
  Daily: "每天",
  Hourly: "每小时",
  Weekly: "每周",
  Weekdays: "工作日",
  Custom: "自定义",
  "min hour dom mon dow": "分 时 日 月 周",
  "Not a cron expression (five fields: minute hour day month weekday)":
    "不是有效的 cron 表达式（五个字段：分 时 日 月 周）",
  "Not a cron expression": "不是有效的 cron 表达式",
  "{described} ({cron}) · next run {when}": "{described}（{cron}）· 下次运行 {when}",
  "Run from the overview, the list or the API; nothing to declare.":
    "从概览、列表或 API 运行；不需要额外声明。",
  "POST /api/workflow-executions with the workflow file and the input; nothing to declare.":
    "POST /api/workflow-executions，带上流程文件和输入；不需要额外声明。",
  "A schedule is part of the definition: switching it on takes effect when the definition is saved. After three failed runs in a row the scheduler stops firing it until a run succeeds.":
    "定时是定义的一部分：打开开关要在定义保存后才生效。连续三次失败后调度器会停止触发，直到有一次运行成功。",

  // Node editors inside the inspector
  "Search nodes…": "搜索节点…",
  "No matching nodes": "没有匹配的节点",
  "Add downstream node": "添加下游节点",
  "Close node menu": "关闭节点菜单",
  "Delete edge": "删除这条边",
  "Delete condition": "删除这个条件",
};
