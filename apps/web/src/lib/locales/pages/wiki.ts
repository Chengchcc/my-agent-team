/** Chinese for the wiki pages (ADR 0079). Keys are the English strings the wiki index, the
 *  reading view, the graph and the shared "Ask the PA" sheet call `t()` with; a missing key
 *  renders English. The integrator merges this into the dictionary. */

export const wikiZh: Record<string, string> = {
  // Page head
  "Wiki · knowledge library": "知识库 · WIKI",
  "Your knowledge base": "你的知识库",
  "Knowledge compiled from the material you bring in. Read it by topic and by relation; it grows into something you can reuse.":
    "从收录的材料里持续整理，沿着主题与关联阅读，慢慢长成可复用的知识。",
  "Let one discussion be the starting point of the next.": "让一次讨论，成为下次工作的起点。",
  "Concepts, project experience and open questions live here. Read a page and follow its citations back to the material, or ask the PA to dig further and file what is worth keeping.":
    "这里保存概念解释、项目经验和仍待核对的问题。你可以直接读文章，沿引用回到材料，也可以让 PA 帮你追问，把值得留下的答案整理进知识库。",
  Page: "页面",
  "Back to the index": "回到目录",
  "Loading…": "加载中……",

  // Tabs
  "Topic index": "主题目录",
  "Related reading": "关联阅读",
  "Structure check": "结构检查",

  // Topic index
  "Search concepts, topics or text…": "搜索概念、主题或正文…",
  "Search the wiki": "搜索知识库",
  "Global search · ⌘K": "全局搜索 · ⌘K",
  "Topic filter": "知识主题筛选",
  "All topics": "全部主题",
  Personal: "个人",
  Projects: "项目",
  Decisions: "决策",
  Concepts: "概念",
  Lessons: "经验",
  "“{term}” · {n} pages": "“{term}” · {n} 篇知识",
  "{n} pages": "{n} 篇知识",
  "Nothing is compiled yet": "还没有整理好的知识",
  "Ask the PA to file what it learned. It writes through its wiki tools, and the page shows up here with its sources and backlinks.":
    "请让 PA 把学到的东西整理进来。它通过自己的知识库工具写入，页面会带着出处和反链出现在这里。",
  "No knowledge matches. Try another word, or": "没有找到匹配的知识。换一个词试试，或",
  "ask the PA": "带着问题与 PA 沟通",
  "Draft · to verify": "草稿 · 待核对",
  Superseded: "已被取代",
  Confirmed: "已确认",
  "Maintained by {name}": "维护：{name}",
  "{n} related pages": "{n} 篇关联阅读",
  "No sources yet": "尚缺出处",

  // Aside
  "Where to start, and how the wiki is maintained": "从这里开始，以及知识库怎样维护",
  "Start here": "从这里开始",
  "The pages other pages cite most.": "被其他页面引用最多的几篇。",
  "No page links to another yet.": "还没有页面互相引用。",
  "Maintenance workflow": "整理流程",
  " · read only": " · 只读",
  "No wiki maintenance workflow is defined.": "没有定义知识库整理流程。",
  "Status: {status}": "流程状态：{status}",
  "Schedule: manual only": "定时触发：未设置，只能手动运行",
  "Schedule: {cron} (UTC)": "定时触发：{cron}（UTC）",
  "Not run yet": "尚未运行",
  "Last run: {status} · {time}": "最近一次运行：{status} · {time}",
  "Organizing runs through that workflow. This page has no separate auto-organize switch.":
    "整理由这个流程负责，本页没有单独的自动整理开关。",
  "Maintenance log: not available.": "整理记录：未提供。",
  "Files and maintenance notes": "文件与维护说明",
  "index.md is rebuilt from the pages on every write, and log.md records each write. The assistant maintains both; this page only reads.":
    "index.md 在每次写入后由页面重建，log.md 记录每次写入。两者都由助理维护，本页只读。",

  // Structure check
  "Checking…": "检查中……",
  "Check again": "重新检查",
  "Checks sources, backlinks and dangling supersedes targets. It does not verify facts or reachability, and it changes nothing.":
    "检查出处、反链和失效的取代目标。不核验事实是否正确或链接是否可达，也不会改动任何内容。",
  Finding: "发现",
  Detail: "详情",
  "No sources": "缺出处",
  Orphan: "无反链",
  "Missing supersedes target": "取代目标不存在",
  "Unknown space": "未知分区",
  "No findings: every page has sources and an inbound link.":
    "没有发现：每个页面都有出处，也都有页面引用它。",

  // Reading view
  "Wiki · read only": "知识库 · 只读",
  "Open full page": "打开完整页面",
  "Maintained by {name} · updated {day}": "维护：{name} · 更新于 {day}",
  "Ask the PA about this page": "围绕这篇提问给 PA",
  Sources: "出处",
  "No sources yet: a draft whose claims cannot be traced.": "还没有出处：这是一份待补出处的草稿。",
  Conversation: "会话",
  File: "文件",
  Link: "链接",
  Source: "出处",
  "Contents, related pages, sources and versions": "目录、关联阅读、出处与版本",
  "On this page": "本文目录",
  "A short note without sections.": "短篇笔记，没有分节。",
  "Read next": "接着读",
  "No related pages yet.": "暂无关联阅读",
  "Backlinks, versions and graph": "反链 / 版本 / 关系图",
  "maintainedBy {name}": "维护者：{name}",
  "revision {revision}": "版本 {revision}",
  Replaces: "取代",
  Backlinks: "反链",
  "Nothing links here yet; the structure check lists this page as an orphan.":
    "还没有页面引用这里；结构检查会把它列为无反链。",
  Versions: "版本",
  "Not available: the wiki returns the current revision only. It keeps no history to list here.":
    "未提供：知识库只返回当前版本，没有可列出的历史。",
  Graph: "关系图",
  "This page does not exist or cannot be read.": "这个页面不存在，或者无法读取。",

  // Graph
  "Nothing to draw yet — the graph grows as pages link each other.":
    "还没有可画的内容——页面之间建立引用后，关系图会长出来。",
  "Wiki link graph: {pages} pages, {links} links": "知识关系图：{pages} 个页面，{links} 条引用",
  "{pages} pages · {links} links · no zoom (open a page to navigate)":
    "{pages} 个页面 · {links} 条引用 · 不支持缩放（打开页面以跳转）",

  // Ask the PA
  "Ask the PA": "提问给 PA",
  "About the wiki": "关于知识库",
  "Please look in the wiki for me.\nQuestion: ": "请帮我查一下知识库。\n问题：",
  "Provide material": "提供材料",
  "The PA files it with its wiki tools": "由 PA 用它的知识库工具收录",
  "Please file this material into the wiki.\nSource (a conversation range, a file or a link): \nWhat to keep: ":
    "请把这份材料整理进知识库。\n来源（会话区间、文件或链接）：\n希望保留的内容：",
  "About “{title}”": "关于《{title}》",
  "About the wiki page “{title}” ({path}): please explain its key points, cite the pages that support them and point out what is still unverified.":
    "请结合知识库页面《{title}》（{path}）解释其中的关键约定，引用支持它的页面，并指出哪些内容尚未核对。",
  "Start a session with this PA, then ask.": "和这位 PA 开始一个会话，再提问。",
  "The request sits in the input for you to edit and send. Opening this panel sends nothing and does not mark the conversation read.":
    "请求已放进输入框，由你修改后再发送。打开这个面板不会发送任何内容，也不会把会话标为已读。",
};
