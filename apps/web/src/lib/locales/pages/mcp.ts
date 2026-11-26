/** Chinese for the MCP connections page. Keys are the English strings the page and its forms
 *  call `t()` with; a missing key renders English. */

export const mcpZh: Record<string, string> = {
  // Head
  "MCP CONNECTIONS · CATALOG": "MCP 连接 · 目录",
  "MCP connections": "MCP 连接",
  "See connection settings and tool catalogs. The catalog, connectivity and execution authorization are stated separately.":
    "查看连接配置与工具目录。目录、连通性和执行授权分别说明。",
  "Ask the PA": "提问给 PA",
  "Add connection": "添加连接",
  "Advice only: the PA has no tool that edits a connection.":
    "仅提供建议：PA 没有能修改连接的工具。",
  "Which MCP connections do the team's members actually use, and are any of them unreachable or unused?":
    "团队成员实际在用哪些 MCP 连接？有没有连不上或没人用的？",
  "A saved connection does not mean it is reachable. The tool catalog appears only after discovery; a connection test does not call any tool.":
    "已保存不代表能连通。工具目录只在发现之后出现；连通测试不会调用任何工具。",

  // Facts
  HTTP: "HTTP",
  SERVER: "服务器",
  CONNECTION: "连接",
  Catalog: "目录",
  "Not discovered": "未发现",
  "{count} tools": "{count} 个工具",
  Connection: "连接",
  "Not tested": "未测试",
  Connecting: "连接中",
  Connected: "已连接",
  Failed: "失败",
  Secrets: "密钥",
  "none stored": "未存储",
  "How many values are stored. Their content is never shown.": "只显示存储了几项，内容从不展示。",
  Members: "成员",
  "{count} bound": "{count} 位绑定",
  "Agent runtime": "运行时挂载",
  "failed to mount": "挂载失败",
  "{count} tools mounted": "已挂载 {count} 个工具",
  "The latest run that mounted this server reported this. It is not the connection test.":
    "这是最近一次挂载该服务的执行报告的结果，不是连通测试。",
  Discovery: "发现",
  "View tool catalog": "查看工具目录",
  Edit: "编辑",
  "Test connection": "测试连接",
  "Bind members": "绑定成员",
  Restart: "重启",
  Delete: "删除",

  // Detail
  "Tools in this connection": "此连接里的工具",
  "Discover tools": "发现工具",
  "Discover again": "重新发现",
  "Connecting…": "连接中…",
  "Not discovered. The list appears only after discovery, which connects to the server.":
    "尚未发现。目录只在发现之后出现，发现时会连接该服务。",
  "The backend could not list the tools: {reason}": "后端未能列出工具：{reason}",
  "status {status} · {latency} ms · schema {hash}":
    "状态 {status} · {latency} ms · 结构哈希 {hash}",
  "The server lists no tools.": "该服务没有列出任何工具。",
  "Connection settings": "连接配置",
  Setting: "配置项",
  Value: "值",
  Transport: "传输方式",
  Command: "命令",
  URL: "地址",
  "No per-tool grants are recorded. In a member's run an MCP tool follows the member's permission mode (ask → approval card, auto → classifier, deny → blocked, yolo → ungated); a test call from this page is neither approved nor audited.":
    "没有按工具记录的授权。在成员的执行里，MCP 工具跟随成员的权限模式（ask → 审批卡片，auto → 分类器，deny → 拦截，yolo → 不设限）；本页的测试调用既不审批，也不记审计。",
  "Bound members": "已绑定的成员",
  Member: "成员",
  "Permission mode": "权限模式",
  Binding: "绑定状态",
  enabled: "已启用",
  disabled: "已停用",
  "No member binds this connection.": "没有成员绑定此连接。",
  "No description": "暂无描述",
  Parameters: "参数",
  Name: "名称",
  Type: "类型",
  Required: "必填",
  required: "必填",
  optional: "可选",
  Description: "描述",
  "The schema lists no parameters.": "结构定义里没有参数。",
  "Arguments JSON": "参数 JSON",
  "Arguments must be a JSON object.": "参数必须是一个 JSON 对象。",
  "A test call runs the tool once, with your login only. It is neither approved nor audited.":
    "测试调用会以你当前的登录身份执行一次该工具，既不审批，也不记审计。",
  "Test call": "测试调用",
  "Call {tool} now?": "现在调用 {tool}？",
  "It runs once with your login only. It is neither approved nor audited, and its result is not kept.":
    "它只以你的登录身份执行一次，既不审批也不记审计，结果不会被保存。",
  "Run the call": "执行调用",
  "Calling…": "调用中…",
  Result: "结果",
  "The call failed": "调用失败",
  "{count} tools in this catalog": "目录里有 {count} 个工具",

  // Test, bind, delete
  "Reconnects from the stored settings and reports what the connection manager saw. It does not call any tool. The answer carries no failure reason.":
    "用已保存的配置重新连接，并报告连接管理器看到的结果。不会调用任何工具，失败时也没有具体原因。",
  "Connected · {count} tools": "已连接 · {count} 个工具",
  "The test request failed: {reason}": "测试请求失败：{reason}",
  "Test again": "再测一次",
  "Testing…": "测试中…",
  Close: "关闭",
  "A bound member's runs can see this connection's tools, under the member's permission mode. Saving rewrites only the members whose box you changed.":
    "成员绑定后，它的执行里就能看到此连接的工具，并受该成员的权限模式约束。保存时只改写你勾选变动过的成员。",
  "No members yet.": "还没有成员。",
  Cancel: "取消",
  "Save {count} changes": "保存 {count} 处改动",
  "Binding not saved": "绑定未保存",
  "Restart {name}?": "重启 {name}？",
  "It disconnects and connects again from the stored settings. It does not call any tool.":
    "断开后用已保存的配置重新连接。不会调用任何工具。",
  "Restart answered: {status}": "重启返回：{status}",
  "Restart failed": "重启失败",
  "Delete {name}?": "删除 {name}？",
  "Members that bind it lose the binding. This cannot be undone.":
    "绑定它的成员会失去该绑定，且无法撤销。",
  "Delete failed": "删除失败",

  // Form
  "ADD CONNECTION": "添加连接",
  "EDIT CONNECTION": "编辑连接",
  "Edit {name}": "编辑 {name}",
  "Configuration only. Saving does not test whether the server is reachable.":
    "这里只改配置。保存不会测试该服务是否可达。",
  "A saved connection does not mean it is reachable. Discover tools or test the connection afterwards.":
    "已保存不代表能连通。之后请发现工具或测试连接。",
  Form: "表单",
  "Paste JSON": "粘贴 JSON",
  "Name *": "名称 *",
  "A connection needs a name.": "连接需要一个名称。",
  "Fixed when the connection was added.": "添加后不可更改。",
  "stdio · command": "stdio · 命令",
  "HTTP · URL": "HTTP · 地址",
  Args: "参数",
  "Separated by spaces.": "以空格分隔。",
  Env: "环境变量",
  Headers: "请求头",
  "One KEY=VALUE per line. Leave empty to keep what is stored; saving replaces every stored value with these lines.":
    "每行一个 KEY=VALUE。留空则保留已存储的内容；填写后保存会用这些行替换全部已存储的值。",
  "{count} values stored, not shown": "已存储 {count} 项，不显示",
  "Every line must be KEY=VALUE, and a stored mask (****) cannot be saved.":
    "每行都必须是 KEY=VALUE，已存储的掩码（****）不能再保存回去。",
  JSON: "JSON",
  'Invalid JSON: expected one server or { "mcpServers": { ... } }':
    'JSON 无效：应是一个服务器对象，或 { "mcpServers": { ... } }',
  "Not saved": "未保存",
  Save: "保存",
  "Saving…": "保存中…",

  // Empty
  "No connections yet": "还没有连接",
  "Add a connection to reach an MCP server's tools from a member's runs.":
    "添加连接后，成员的执行里才能使用该 MCP 服务的工具。",
  "No members yet, so nothing binds a connection.": "还没有成员，所以没有对象可以绑定连接。",
};
