/** Authority ledger page dictionary. Keys are the English strings the page
 *  calls `t()` with; a missing key renders English. The three source words
 *  (`owner`, `human`, `dispatch`) are translated by the Observability
 *  dictionary, where the run dialog's pill already uses them. */

export const authorityZh: Record<string, string> = {
  "Authority needs a source, not a rubber stamp. Each run's record says whether a person asked for it, the workspace owner's configuration allowed it, or another run dispatched it.":
    "权责要有来路，不需要走过场的审批。每条运行记录都写明：是人提出的、工作区所有者的配置允许的，还是另一次运行派发的。",
  "Read-only evidence": "只读证据",
  "This is a record, not an authorization control plane.": "这是记录，不是授权控制面。",
  "It takes no approvals, grants nothing and changes no permission. Expand a source chain to read its basis; a link opens only a conversation that still exists.":
    "这里不接收审批、不授予任何权限、不改动任何权限。展开来源链可以查看依据；链接只会打开仍然存在的会话。",
  "Source type": "来源类型",
  Record: "记录",
  Context: "上下文",
  "A person asked for it.": "由人提出。",
  "Dispatched by run {id}": "由运行 {id} 派发",
  "Worker result from {id}": "来自 {id} 的工作回传",
  "Work handed back from run {id}": "退还了运行 {id} 交来的工作",
  result: "回传",
  handback: "退回",
  unrecorded: "未记录",
  "Basis not recognised: {basis}": "无法识别的依据：{basis}",
  "Started by the system.": "由系统启动。",
  "Accepted by the assessment gate.": "经语义评估放行。",
  'Under the standing rule "{rule}"': "依据常设规则「{rule}」",
  "Unrecorded: this run has no stored basis.": "未记录：这次运行没有保存依据。",
  "Source chain": "来源链",
  "this run": "本次运行",
  parent: "上级运行",
  root: "源头",
  "parent not loaded": "上级运行不在已加载的范围内",
  "Conversation not available": "会话不可用",
  "This conversation is no longer listed.": "这个会话已不在列表中。",
  "The conversation list could not be read.": "会话列表读取失败。",
  "No run under this source in the loaded window.": "已加载的范围内没有这种来源的运行。",
  "Would have acted": "本会采取的行动",
  "{count} recorded · {total} events": "{total} 条事件，其中 {count} 条仅为记录",
  "Rules in record mode and the assessment gate in observe mode write here. Nothing in this table ran, and nothing here can be approved from this page.":
    "处于「仅记录」模式的规则和处于「观察」模式的语义评估会写到这里。这张表里没有任何内容被执行，也无法在本页被批准。",
  "Nothing recorded yet": "还没有记录",
  "A rule in record mode or the assessment gate in observe mode writes the first row.":
    "处于「仅记录」模式的规则或处于「观察」模式的语义评估会写下第一行。",
  When: "时间",
  Outcome: "结果",
  "would have acted": "本会采取行动",
  "started a run": "已启动运行",
  "failed to assess": "评估失败",
  Rule: "规则",
  "A run older than the authorization record reads as unrecorded; nothing is filled in for it. The list holds the last 200 runs, so a parent outside that window ends its chain.":
    "早于授权记录的运行显示为「未记录」，不会为它补写任何依据。列表只包含最近 200 次运行，上级运行不在这个范围内时，来源链到此为止。",
};
