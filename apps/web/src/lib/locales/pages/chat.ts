/** The conversation overview's words (`/chat`): its head, the PA chips, the filters, the cards
 *  and the new-conversation dialog. */
export const chatZh: Record<string, string> = {
  "Work sessions · every PA": "工作会话 · 全部 PA",
  "Every conversation with a PA, grouped by the PA that owns it. A dispatched room sits with the PA that dispatched it. Starting work does not require a project room.":
    "与 PA 的每一个会话，按所属 PA 分组。派发出的子会话归在派发它的 PA 下面。开始工作不要求先建项目房间。",
  "A conversation does not record whether it came from a Lark chat or a Lark group. Its only source fact is how it began: started in a chat, forked, or dispatched by a PA.":
    "会话不记录它来自 Lark 私聊还是群。唯一的来源事实是它如何开始：在聊天里发起、分叉，或由 PA 派发。",
  "No Lark bot enabled": "未启用 Lark Bot",
  "Worker · direct room": "Worker · 直连房间",
  "{n} work session": "{n} 个工作会话",
  "{n} work sessions": "{n} 个工作会话",
  "{n} dispatched": "{n} 个派发",
  "{n} dispatched room": "{n} 个派发子会话",
  "{n} dispatched rooms": "{n} 个派发子会话",
  "{n} conversation total": "共 {n} 个会话",
  "{n} conversations total": "共 {n} 个会话",
  "{n} started in a chat": "{n} 个在聊天中发起",
  "{n} fork": "{n} 个分叉",
  "{n} forks": "{n} 个分叉",
  "Counted by conversation, not by work item.": "按会话计数，不按工作事项计数。",
  "All PAs": "全部 PA",
  "All sources": "全部来源",
  "Started in a chat": "聊天中发起",
  Fork: "分叉",
  "Dispatched room": "派发子会话",
  "Filter by PA": "按 PA 筛选",
  "Search and source filter": "搜索与来源筛选",
  "Search a conversation, a PA or a project": "搜索会话、PA 或项目",
  "{total} conversations: {chats} started in a chat, {forks} forks, {dispatched} dispatched rooms. Counted by conversation, not by work item.":
    "共 {total} 个会话：{chats} 个在聊天中发起、{forks} 个分叉、{dispatched} 个派发子会话。按会话计数，不按工作事项计数。",
  "No conversation matches these filters.": "没有符合这些筛选的会话。",
  "Clear filters": "清除筛选",
  "No member": "无成员",
  "a member that is no longer registered": "已不在注册表中的成员",
  "{n} need your decision": "{n} 项需要你决定",
  "nothing waiting on you": "无需你处理",
  "dispatched from {title}": "派发自：{title}",
  "Created {created} · last activity {ago}": "创建于 {created} · 最近活动 {ago}",
  "Open {title}": "打开 {title}",
  "Messages that contain “{query}”": "包含“{query}”的消息",
  "Searching messages…": "正在搜索消息…",
  "The messages could not be searched.": "无法搜索消息。",
  "No message contains this text.": "没有消息包含这段文字。",
  "Could not load the conversations.": "无法加载会话。",
  "Start one with a PA. It is listed here, under that PA.":
    "和 PA 开始一个会话。它会列在这里，归在那位 PA 下面。",
  "Opens a conversation with one PA. A first message is optional; when given, it is sent as soon as the conversation opens.":
    "和一位 PA 开始会话。第一条消息可填可不填；填了的话，会话一打开就会发送。",
  "There is no PA to talk to yet. Create one on the team page first.":
    "还没有可以对话的 PA。请先在团队页面创建。",
  "Project (optional)": "项目（可选）",
  "This PA is attached to no project, so its runs start in its own workspace.":
    "这位 PA 没有关联项目，它的执行在自己的工作区里开始。",
  "Only the projects this PA is attached to. Runs then start in that project's worktree.":
    "只列出这位 PA 关联的项目。执行会在该项目的 worktree 里开始。",
  "First message (optional)": "第一条消息（可选）",
  "What do you want to work on?": "你想做什么？",
  "Create and send": "创建并发送",
  "The conversation was not created": "会话没有创建成功",
};
