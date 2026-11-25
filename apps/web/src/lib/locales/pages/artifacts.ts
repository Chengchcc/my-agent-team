/** Artifacts (the evidence gallery) page dictionary: the page, the cards, the
 *  detail dialog and the sheet a conversation opens. Keys are the English
 *  strings `t()` is called with; a missing key renders English. */

export const artifactsZh: Record<string, string> = {
  "Evidence gallery": "证据陈列",
  "Every result keeps where it came from. From the delivery summary to a fixed revision, “done” becomes something you can look at.":
    "每份成果，都带着来路。从交付摘要到固定版本，把“做完了”变成可以查看的结果。",
  Documents: "文档",
  Changes: "代码改动",
  Visual: "视觉探索",
  Other: "其它",
  "{count} files · {size} · each file keeps the member and the run that produced it":
    "{count} 个文件 · {size} · 每个文件都记着产出它的成员和运行",
  Folder: "目录",
  "All folders": "全部目录",
  "Filter by file name or address": "按文件名或地址筛选",
  Layout: "视图",
  "Grid view": "网格视图",
  "List view": "列表视图",
  "No artifacts yet": "还没有产物",
  "Artifacts are the files an agent writes during a run, or the ones you upload here. Opening this page produces none.":
    "产物是 Agent 在运行中写出的文件，或你在这里上传的文件。打开本页不会产生任何产物。",
  "No file matches this filter.": "没有符合这次筛选的文件。",
  "Clear filter": "清除筛选",
  "A card's preview is the file's own content, read when the card comes into view. The product keeps no check or revision for a stored file, so there is nothing to accept here.":
    "卡片上的预览就是文件本身的内容，在卡片进入视野时读取。产品不为已存储的文件保存检查结果或版本，所以这里没有可“验收”的东西。",
  Upload: "上传",
  "Upload failed: {reason}": "上传失败：{reason}",
  "Uploading…": "上传中……",
  "Pick a file and name a folder. The file is stored under the address shown below.":
    "选择一个文件并填写目录名。文件会存到下面显示的地址。",
  "Choose a file": "选择文件",
  Address: "地址",
  Preview: "预览",
  Download: "下载",
  "Download failed: {reason}": "下载失败：{reason}",
  'Delete "{name}"?': "删除「{name}」？",
  "The file is removed from the registry. This cannot be undone.":
    "文件会从产物库中移除，此操作无法撤销。",
  "Delete failed: {reason}": "删除失败：{reason}",
  "View diff": "查看 Diff",
  "Back to the file": "返回文件",
  "Stored file": "已存储的文件",
  "Source and evidence": "来源与证据",
  "No member recorded": "未记录成员",
  Evidence: "证据",
  "The product keeps no check, review or revision for a stored file.":
    "产品不为已存储的文件保存检查、审阅或版本记录。",
  "Reading this is not approving a merge, and it does not accept a delivery.":
    "阅读完成不等于批准合并，也不代表接受交付。",
  "No preview": "无预览",
  "Preview unavailable": "预览不可用",
  "{count} files": "{count} 个文件",
  "+{count} more rows": "还有 {count} 行",
  "The diff as it was stored. Nothing was compared with a repository, merged or pushed from here.":
    "这是存储下来的 diff。这里没有与代码仓库比对，也没有合并或推送。",
  "This file does not hold a recognisable diff. Its text is shown as it is stored.":
    "这个文件里没有可识别的 diff，按存储的原样显示文字。",
  "The file could not be loaded: {reason}": "文件加载失败：{reason}",
  "No preview for {mime} ({size}). Download it to open it.":
    "{mime} 没有预览（{size}）。下载后打开。",
  "{count} characters": "{count} 个字符",
  "Open {name}": "打开 {name}",
  "Comment on lines": "按行评论",
  "Comment on these lines…": "对这几行写下评论…",
  Comment: "评论",
  "The comment was not sent: {reason}": "评论没有发出：{reason}",
  "+{count} more lines are not shown": "还有 {count} 行未显示",
  "truncated (256K cap)": "已截断（上限 256K）",
};
