/** The Chinese dictionary (ADR 0079). Keys are the English source strings the
 *  components call `t()` with — a missing key simply renders English, so the
 *  two languages cannot drift apart silently. This file is the only place in
 *  apps/web/src where Chinese UI text is allowed (`audit:ui`).
 *
 *  Vocabulary follows the product's own words (ADR 0074): 需求 for a tracked
 *  requirement, 前台 for the front desk, 成员 for a team member, 派单 for a
 *  dispatch. "Requirements" stays 需求 rather than 任务: the Today page already
 *  has a "Tasks" section, and two things must not share one word. */

export const zh: Record<string, string> = {
  // ── Navigation ───────────────────────────────────────────────
  Today: "指挥台",
  Coding: "工作台",
  Requirements: "需求",
  Workflows: "流程",
  Artifacts: "产物",
  Chat: "会话",
  Agents: "成员",
  Skills: "技能",
  MCP: "工具",
  Wiki: "知识库",
  Projects: "项目",
  System: "系统",
  Settings: "设置",
  Team: "团队",
  Work: "工作",
  Capabilities: "能力",
  Authority: "授权",

  // ── Breadcrumbs ───────────────────────────────────────────────
  "Agent Runs": "成员的执行",
  Runs: "执行",
  New: "新建",

  // ── Page titles ──────────────────────────────────────────────
  "Agent Chat": "成员会话",
  Agent: "成员",
  "Create Agent": "新成员",
  "MCP Servers & Tool Bindings": "工具（MCP）与绑定",
  Requirement: "需求",
  Proposals: "提案",
  "How this page works": "这一页怎么用",
  Executions: "执行记录",

  // ── Shell ────────────────────────────────────────────────────
  Search: "搜索",
  "Search conversations": "搜索会话",
  "Search chats, wiki, agents, projects...": "搜索会话、知识库、成员、项目…",
  "Toggle Sidebar": "收起 / 展开侧栏",
  Account: "账户",
  "Account settings": "账户设置",
  "Signed in as": "登录为",
  "English is the source; the other languages are dictionaries of it.":
    "英文是源语言，其它语言是它的词典；没翻译的句子保持英文。",
  "Sign Out": "退出登录",
  Close: "关闭",
  Language: "界面语言",
  "New conversation": "新会话",
  "Conversation actions": "会话操作",
  "No conversations yet": "还没有会话",
  "Front desk": "前台",
  "Front desk (routes)": "前台（自动分派）",
  "No project": "不绑定项目",
  Cancel: "取消",
  Create: "创建",
  "Talk to the front desk, or pick a team member for a direct line (bypasses routing).":
    "和前台说话，或者直连某个成员（绕过前台分派）。",
  "Bind it to a project so the room's work happens in that project's copy.":
    "绑定一个项目，这个房间里的活就在该项目的副本里做。",
  "New conversation created. Say what you need.": "会话已建好。说说你要什么。",

  // ── Common actions and states ────────────────────────────────
  Run: "运行",
  Delete: "删除",
  Edit: "编辑",
  Save: "保存",
  Copy: "复制",
  Adopt: "采纳",
  Discard: "丢弃",
  "Loading…": "加载中…",
  "Nothing pending.": "没有待处理的提案。",
  "Nothing waiting for a decision.": "没有等你拍板的事。",
  "Nothing open.": "没有进行中的任务。",
  Tasks: "任务",
  "Needs you": "等你",
  "Finished, unseen": "已完成，未读",
  Open: "打开",
  "(direct line)": "（直连）",
};
