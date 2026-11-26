/** Settings page dictionary: the page, its five field cards and the Raw JSON
 *  view's own words (including the reasons of `settings-json.ts`). Keys are
 *  the English strings `t()` is called with; a missing key renders English. */

export const settingsZh: Record<string, string> = {
  "Workspace settings": "工作区设置",
  "The common settings first, the complex ones folded. Every form saves where its button says; Raw JSON saves only what you validated.":
    "常用配置先看，复杂内容再展开。每个表单在它按钮写明的地方保存；原始 JSON 只保存你校验过的改动。",
  "Search name, model, credential, permission…": "搜索名称、模型、凭据、权限…",
  "Search settings fields": "搜索设置字段",
  "Settings mode": "设置模式",
  "Raw JSON": "原始 JSON",
  "Settings sections": "设置分区",
  "No matching field.": "没有找到匹配的字段。",
  "Help me review the workspace settings and suggest what to change.":
    "帮我看看工作区设置，并建议哪些该改。",
  "Each form saves on its own: the dispatch switch and the language choice at once, the others with their Save button. Nothing here saves by itself.":
    "每个表单各自保存：派发开关和界面语言即时生效，其余通过各自的保存按钮生效。这里没有任何内容会自动保存。",

  // Sections
  "Models & credentials": "模型与凭据",
  "Execution & permissions": "执行与权限",
  Advanced: "高级",
  "Advanced · {title}": "高级 · {title}",
  "Set how you read the console and how you sign in to it.": "设置控制台的界面语言和登录密码。",
  "Check which provider keys are set. Whether a provider answers is a separate fact, read on the member's own page.":
    "查看哪些提供商的密钥已设置。提供商是否能连通是另一件事，在成员自己的页面上查看。",
  "How a dispatch opens a room, and how much of the “is this work?” decision is delegated.":
    "控制派发如何开启房间，以及“这算不算工作”的判断有多少交给模型。",
  "What the backend reports about itself. Nothing here can be changed.":
    "后端对自身情况的报告。这里的内容无法修改。",

  // Workspace
  "Interface language": "界面语言",
  "The choice saves at once and reloads the page.": "选择后立即保存并重新加载页面。",
  "Login password": "登录密码",
  "Checking password status…": "正在检查密码状态……",
  "set here": "在此设置",
  "launcher default": "启动器默认值",
  "A password set here is stored as a hash and is the one that logs in.":
    "在这里设置的密码以哈希形式保存，并用它登录。",
  "Until you set one, the password generated at first start (gateway-secrets.json, or the dev .env) is the one that logs in.":
    "设置之前，首次启动时生成的密码（gateway-secrets.json，或开发环境的 .env）就是登录密码。",
  "Change password": "修改密码",
  "Change login password": "修改登录密码",
  "Starts working right away — no restart, and the plaintext is never stored.":
    "立即生效，无需重启；明文不会被保存。",
  "New password (at least {count} characters)": "新密码（至少 {count} 个字符）",
  "Repeat it": "再输入一次",
  "At least {count} characters.": "至少 {count} 个字符。",
  "The two entries differ.": "两次输入不一致。",

  // Models & credentials
  "Provider keys": "提供商密钥",
  "{set} of {total} configured": "{total} 个中 {set} 个已配置",
  "A key is stored on the server and handed to agent runs; nothing is sent back to the browser after saving. A key being set says nothing about whether the provider answers.":
    "密钥保存在服务端并交给 Agent 运行使用；保存后不会回传给浏览器。密钥已设置并不代表该提供商能连通。",
  "Loading providers…": "正在加载提供商……",
  "No known providers.": "没有已知的提供商。",
  configured: "已配置",
  "not configured": "未配置",
  Update: "更新",
  Set: "设置",
  "{name} API key": "{name} 的 API 密钥",
  "Stored on the server and handed to agent runs; nothing is sent to the browser after saving.":
    "保存在服务端并交给 Agent 运行使用；保存后不会回传给浏览器。",
  "{name} value": "{name} 的值",
  "Base URL": "基础地址",
  "Optional proxy base URL": "可选的代理基础地址",
  Clear: "清除",
  "Custom provider keys": "自定义提供商密钥",
  "For a provider your models.yml declares — the name it looks up, like ZAI_API_KEY.":
    "用于 models.yml 里声明的提供商，填它读取的变量名，例如 ZAI_API_KEY。",
  "Add key": "添加密钥",
  "Add a provider key": "添加提供商密钥",
  "Use the env var name that provider expects; it is stored on the server and used by the next agent run.":
    "填该提供商期望的环境变量名；它保存在服务端，下一次 Agent 运行时生效。",
  "Needs the shape ZAI_API_KEY (upper case, ending in _API_KEY).":
    "需要形如 ZAI_API_KEY（大写，以 _API_KEY 结尾）。",
  "the key itself": "密钥本身",

  // Execution & permissions
  Dispatch: "派发",
  on: "已开启",
  "On: every dispatch to the same worker continues one room under this conversation. Off: each dispatch opens its own room, so a new task starts without the previous one's context.":
    "开启：向同一位 Worker 的每次派发都延续这个会话下的同一个房间。关闭：每次派发都新开一个房间，新任务不带上一个任务的上下文。",
  "Reuse the worker's room": "复用 Worker 的房间",
  "The switch saves this one key as soon as you flip it.": "一拨动开关，这个配置项就立即保存。",
  "Semantic assessment": "语义评估",
  "Group messages that mention nobody and miss every rule can be judged by a model: is this work for the team, and who should take it? The prompt is fixed product code. What you choose here is whether it runs and what happens to its verdict.":
    "没有 @ 任何人、也没命中任何规则的群消息，可以交给模型判断：这是不是交给团队的工作，该由谁来接？提示词是固定的产品代码。你在这里决定的是它是否运行，以及判断结果怎么处理。",
  Mode: "模式",
  "Off — don't ask": "关闭 —— 不询问",
  "Observe — record only": "观察 —— 只记录",
  "Auto — dispatch on accept": "自动 —— 接受即派发",
  "Never asks a model. Only the rules you wrote can create work.":
    "不询问模型。只有你写的规则能创建工作。",
  "Asks, but only records “it would have taken this” — nothing runs.":
    "会询问，但只记录“它本会接下这件事”，不会运行任何东西。",
  "Asks and dispatches the accepted ones. No confirmation.":
    "会询问，并直接派发被接受的事项，不需要确认。",
  Provider: "提供商",
  "Pick a provider": "选择提供商",
  "Pick a model": "选择模型",
  "Accepted messages start runs without your confirmation. Start with Observe and read the ledger first.":
    "被接受的消息会不经你确认直接启动运行。建议先从“观察”开始，并先读一读授权账本。",
  "Save gate": "保存评估设置",
  "Pick a model, or set the mode to Off.": "请选择模型，或把模式设为关闭。",
  "The authority ledger shows what it decided.": "授权账本记录了它的判断。",
  "Assessment gate saved": "评估设置已保存",
  "Could not save the gate": "评估设置保存失败",

  // Advanced
  "System info": "系统信息",
  "Environment and paths as the backend reports them.": "后端上报的环境变量与路径。",
  Environment: "环境变量",
  "No env vars exposed.": "没有对外公开的环境变量。",
  Paths: "路径",
  "The backend did not answer the system-info request: {reason}":
    "后端没有响应系统信息请求：{reason}",

  // Raw JSON
  "Only the settings the product reads can change here: {keys}. Keys managed elsewhere may stay as they are but never change here; a stored key left out is refused; a credential never goes in.":
    "这里只能修改产品会读取的设置：{keys}。由别处管理的配置项可以原样保留，但不能在这里修改；漏掉一个已存储的配置项会被拒绝；凭据不能写在这里。",
  "JSON · the stored document, not a config file": "JSON · 已存储的文档，不是配置文件",
  "Validate and preview diff": "校验并预览差异",
  "Back to the stored document": "恢复为已存储的文档",
  "Nothing can be saved from this document:": "这份文档不能保存：",
  "Validated. No value would change; there is nothing to save.":
    "校验通过。没有任何值会变化，无需保存。",
  "Validated. {count} changes below. Nothing is saved until you save.":
    "校验通过，共 {count} 处改动如下。在你保存之前不会写入任何内容。",
  Current: "当前值",
  Draft: "草稿值",
  "Save {count} changes?": "保存 {count} 处改动？",
  "Each change is written on its own, in order. A key the backend refuses keeps its stored value and is listed.":
    "每处改动按顺序单独写入。被后端拒绝的配置项保留原值，并列出来。",
  "Saved {count} changes.": "已保存 {count} 处改动。",
  "{saved} changes were saved; {failed} were refused and keep their stored value:":
    "已保存 {saved} 处改动；{failed} 处被拒绝，保留原值：",
  "Validate again before saving what is left.": "保存剩余改动前请重新校验。",
  "The stored settings could not be read: {reason}": "已存储的设置读取失败：{reason}",

  // The four settings Raw JSON may change
  "Reuse the worker's room across dispatches": "派发时复用 Worker 的房间",
  "Semantic assessment gate": "语义评估开关",
  "Daily budget in USD; no new runs start past it": "每日预算（美元），超出后不再启动新的运行",
  "Hosts sandboxed runs may reach; read at startup": "沙箱内运行可以访问的主机，启动时读取",

  // Reasons (settings-json.ts)
  "Not valid JSON: {detail}": "不是有效的 JSON：{detail}",
  'The document must be one object with a single "settings" key holding an object.':
    '文档必须是一个对象，且只有一个 "settings" 键，值为一个对象。',
  "{key} is not a setting this product reads or writes.": "{key} 不是本产品会读写的设置。",
  "{key} is managed by {where}; change it there.": "{key} 由{where}管理，请到那里修改。",
  "the password and credential forms": "密码与凭据表单",
  "{key} is missing. The settings API cannot delete a key, so it would keep its stored value.":
    "缺少 {key}。设置接口不能删除配置项，它会保留已存储的值。",
  "{key}: {detail}": "{key}：{detail}",
  "{key}: a plain secret is not accepted here. Credentials go to Models & credentials.":
    "{key}：这里不接受明文密钥。凭据请填到“模型与凭据”。",

  // The checks' details, as `reasonText` passes them through t()
  "must be true or false": "必须是 true 或 false",
  "must be an object": "必须是一个对象",
  'has an unknown field "{name}"': "含有未知字段“{name}”",
  "mode must be off, observe or auto": "mode 必须是 off、observe 或 auto",
  "model must be a string": "model 必须是字符串",
  "must be a number greater than 0": "必须是大于 0 的数字",
  "must be a list of host names": "必须是主机名列表",
  "must be a list of non-empty host names": "必须是非空主机名的列表",
};
