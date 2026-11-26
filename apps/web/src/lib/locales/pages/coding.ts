/** Coding's words (`/coding`): the head, the toolbar, the terminal inventory, the locate miss
 *  and the New terminal dialog. The worktree management's words were already in the dictionary. */
export const codingZh: Record<string, string> = {
  "Terminals · every member": "终端 · 全部成员",
  "A clear work site for code work. Each member's console keeps its own context, and a view keeps running when you leave this page.":
    "给代码工作一个清楚的现场。每位成员的控制台保留独立上下文；离开这一页后视图仍在运行。",
  "New terminal": "新建终端",
  "{open} open views · {running} running": "{open} 个打开的视图 · {running} 个运行中",
  "Needs at least two terminals in this scope. It never creates one.":
    "这个范围里至少要有两个终端。它不会自动新建。",
  "Single view": "单栏视图",
  "Split · two columns": "分栏 · 两列",
  "Terminals · all": "终端 · 全部",
  "Focus only brings a view to the front. It never creates a terminal.":
    "聚焦只是把视图调到前面。它不会新建终端。",
  "No terminal yet. New terminal starts one.": "还没有终端。新建终端会启动一个。",
  "Own workspace": "个人工作区",
  Focus: "聚焦",
  shell: "shell",
  exited: "已退出",
  working: "工作中",
  blocked: "被阻塞",
  "not ready": "未就绪",
  "No terminal to locate": "没有可定位的终端",
  "No member with the id {id} is registered.": "没有登记 id 为 {id} 的成员。",
  "No project with the id {id} is registered.": "没有登记 id 为 {id} 的项目。",
  "{name} has no terminal yet.": "{name} 还没有终端。",
  "{name} has no terminal in {scope}. It has {n} elsewhere: {places}.":
    "{name} 在{scope}里没有终端。它在别处有 {n} 个：{places}。",
  "its own workspace": "自己的工作区",
  "This link only locates a view that already exists. Nothing was created.":
    "这个链接只定位已有的视图。没有创建任何东西。",
  "Create terminal": "创建终端",
  Dismiss: "关闭提示",
  "One pane with a shell in the chosen scope. It starts a real process that keeps running when you leave this page.":
    "在所选范围里开一个带 shell 的窗格。它会启动一个真实进程，离开这一页后仍在运行。",
  "Member's own workspace": "成员自己的工作区",
  "No member can be chosen for this scope.": "这个范围里没有可选的成员。",
  "No member is attached to this project. Attach one on the Projects page first.":
    "这个项目还没有接入成员。请先在项目页面接入。",
  "Every enabled member. A member's workspace is the directory its rooms run in.":
    "列出所有已启用的成员。成员的工作区就是它的会话所在的目录。",
  "Only the members attached to the selected project.": "只列出所选项目已接入的成员。",
  "process exited ({code})": "进程已退出（{code}）",
  live: "在线",
  "connecting…": "连接中……",
  "reconnecting…": "重新连接中……",
  "This context": "当前上下文",
};
