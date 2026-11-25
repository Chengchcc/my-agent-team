/** Chinese for the skill packages page, the register dialog and the pack file browser. Keys are
 *  the English strings they call `t()` with; a missing key renders English. */

export const skillsZh: Record<string, string> = {
  // Head
  "SKILL PACKAGES · REGISTRY": "技能包 · 注册表",
  "Skill packages": "技能包",
  "See which skills a pack holds, open its description and files, then decide who uses it.":
    "查看包里有哪些技能，打开说明与文件，再决定给谁使用。",
  "Ask the PA": "提问给 PA",
  "Advice only: the PA has no tool that manages skill packs.":
    "仅提供建议：PA 没有能管理技能包的工具。",
  "Which skill packs are worth keeping, and is any of them assigned to members who do not use it?":
    "哪些技能包值得保留？有没有分配给了并不使用它的成员？",
  Lockfile: "Lockfile",
  "Register skill pack": "登记技能包",

  // Hero
  "See what is in a pack first.": "先看包里有什么。",
  "Registration, being on disk and the check are recorded separately. A materialized pack's SKILL.md and referenced files are readable; a pack that is not on disk says its files are unavailable. Nothing here downloads, installs or runs a skill.":
    "包登记、物化与检查分别记录。已物化的包可以阅读 SKILL.md 与引用文件；不在磁盘上的包会明确显示文件不可用。这里不会下载、安装或执行技能。",

  // Facts
  "SKILL PACK": "技能包",
  Registered: "已登记",
  yes: "是",
  Materialized: "已物化",
  no: "否",
  "in progress": "进行中",
  "The last check looked at the disk.": "来自最近一次检查，它查看了磁盘。",
  "From the install record; no check has looked at the disk yet.":
    "来自安装记录；还没有检查查看过磁盘。",
  Check: "检查",
  "not checked": "未检查",
  passed: "通过",
  failed: "失败",
  Members: "成员",
  "{count} assigned": "{count} 位已分配",
  "Files readable": "文件可读",
  "Skill files not available · not materialized": "技能文件不可用 · 未物化",
  "View pack and skills": "查看包与技能",
  "Assign members": "分配成员",
  "Sync from Git": "从 Git 同步",
  Uninstall: "卸载",
  Builtin: "内置",
  "ZIP upload": "ZIP 上传",
  "The check covers every pack at once; its result stays until it is run again and is not stored by the backend.":
    "检查会一次覆盖所有包；结果保留到下次检查为止，后端不会存储它。",

  // Sheet
  "Skills in this pack": "包里的技能",
  "Files are not available: this pack is not materialized on disk":
    "文件不可用：这个包没有物化到磁盘",
  "Skill files": "技能文件",
  "Assign to members": "分配给成员",
  "Reading files…": "正在读取文件…",
  "File not available": "文件不可用",
  "The pack holds no skill.": "这个包里没有技能。",
  "Search pack files": "搜索包内文件",
  "No matching file": "没有匹配的文件",
  Close: "关闭",

  // Check dialog
  CHECK: "检查",
  "The check reads each skill's SKILL.md. It does not run the pack, scan dependencies or verify the source.":
    "检查只读取每个技能的 SKILL.md。它不会运行包、扫描依赖或验证来源。",
  "Checking…": "检查中……",
  "The check failed: {reason}": "检查失败：{reason}",
  "The check returned no row for this pack.": "检查结果里没有这个包。",
  "Passed: {count} skills with a readable SKILL.md": "通过：{count} 个技能的 SKILL.md 可读",

  // Assign dialog
  "Adds or removes only this pack for the members whose box you changed. Other packs of a member stay as they are, and nothing is installed.":
    "只为你勾选变动过的成员增删这一个包。成员的其他技能包保持不变，也不会安装任何东西。",
  "No members yet.": "还没有成员。",
  Cancel: "取消",
  "Save {count} changes": "保存 {count} 处改动",
  "Loading…": "加载中……",
  "Assignment not saved": "分配未保存",

  // Lockfile
  LOCKFILE: "LOCKFILE",
  "Read-only JSON, as the backend writes it. No credentials are in it; select the text to copy it by hand.":
    "只读的 JSON，与后端写出的内容一致。其中不含凭据；也可以选中文字手动复制。",
  "Not available: {reason}": "未提供：{reason}",
  "Copied.": "已复制。",
  "The browser refused the clipboard; select the text instead.":
    "浏览器拒绝了剪贴板访问，请直接选中文字复制。",
  "Copy JSON": "复制 JSON",

  // Sync and uninstall
  "Sync {name} from Git?": "从 Git 同步 {name}？",
  "Pulls the pinned revision again from the repository and reinstalls the pack. If the upstream moved, nothing is installed until you confirm the new revision.":
    "从仓库重新拉取固定的版本并重装这个包。如果上游已经变动，在你确认新版本之前不会安装任何东西。",
  Sync: "同步",
  "Sync failed": "同步失败",
  "The upstream moved": "上游已变动",
  "The pinned revision {from} is gone; the repository is at {to}. Sync to the new revision?":
    "原先固定的版本 {from} 已不存在，仓库现在在 {to}。同步到新版本？",
  "Sync to the new revision": "同步到新版本",
  "Uninstall {name}?": "卸载 {name}？",
  "Removes the pack and its files. Members that have it keep their other skills. This cannot be undone.":
    "移除这个包及其文件。拥有它的成员保留其他技能。此操作无法撤销。",
  "Uninstall failed": "卸载失败",

  // Empty
  "No skill packs yet": "还没有技能包",
  "Register a pack to give members reusable skills.": "登记一个包，让成员可以复用技能。",

  // Register dialog
  "REGISTER SKILL PACK": "登记技能包",
  "Saving registers the pack and starts the install: a Git source is cloned, a ZIP is uploaded.":
    "保存会登记这个包并开始安装：Git 来源会被克隆，ZIP 会被上传。",
  "Register and install": "登记并安装",
  "Registering…": "登记中…",
  "Source type": "来源类型",
  "Git · repository URL": "Git · 仓库地址",
  "ZIP · local file": "ZIP · 本地文件",
  "Repository URL *": "仓库地址 *",
  "Every directory with a SKILL.md becomes one skill of the new pack. /tree/branch/path URLs are supported.":
    "每个含 SKILL.md 的目录会成为新包里的一个技能。支持 /tree/branch/path 形式的地址。",
  "Branch or ref": "分支或版本",
  "Keep synced with the Git repository (a manual sync stays available)":
    "与 Git 仓库保持同步（仍可手动同步）",
  "ZIP file *": "ZIP 文件 *",
  "Choose ZIP": "选择 ZIP",
  "One or more skill directories inside the ZIP are validated and imported into one new pack.":
    "ZIP 里的一个或多个技能目录会被校验，并导入为一个新包。",
  "Pack name *": "包名称 *",
  Description: "描述",
  "The pack needs a name.": "包需要一个名称。",
  "A Git source needs a repository URL.": "Git 来源需要仓库地址。",
  "Choose a ZIP file.": "请选择一个 ZIP 文件。",
  "Not registered": "未登记",
  Remove: "移除",

  // PackAgentsTab (project editor)
  "Not assigned to any member yet.": "还没有分配给任何成员。",
  Assigned: "已分配",
  "Remove {name}": "移除 {name}",
};
