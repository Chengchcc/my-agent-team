# oma 内核防线

oma 运行内核里已经存在的防线：路径 jail、URL guard、审批管线、插件信任链、凭据剥离。本页说清每条挡什么、留白在哪。

## 范围

覆盖：`WorkspaceSandbox`、URL guard 与默认 fetch port、审批管线、native 权限门（含 auto 分类器与子 agent 穿透）、插件信任链、凭据剥离与哨兵测试。

不覆盖：系统级的边界正交视图（见 [隔离与安全模型](./overview.md)）、bash 沙箱的实现细节与未完成项（见 [bash 沙箱](./bash-sandbox.md)）、还没修的问题（见 [安全与债务清单](./debt.md)）。

## 实现文件

- `apps/oh-my-agent/src/core/tools/workspace-sandbox.ts` — 路径 jail
- `apps/oh-my-agent/src/core/tools/url-guard.ts` — 协议、私网、DNS 校验
- `apps/oh-my-agent/src/core/tools/web-ports-std.ts` — 默认 fetch port，逐跳复验
- `apps/oh-my-agent/src/core/runtime/approval.ts` — 审批类型、deadline、无管线时的兜底
- `apps/oh-my-agent/src/core/runtime/run-runtime.ts` — 权限门、`.oma/settings.json` 白名单、沙箱装配
- `apps/oh-my-agent/src/core/plugins/{plugin-trust,plugin-resolve}.ts` — 信任哈希与作用域乘模式矩阵
- `packages/agent-contract/src/env.ts` — 子进程环境变量白名单

## 路径 jail

`validate()` 对已存在的路径做两次检查：resolve 后在 root 前缀内，且 realpath 也在 root 内——第二道挡 symlink 逃逸。

`validateNew()` 处理还不存在的目标：向上找到最近一个已存在的父目录，查它的 realpath，挡住「中间目录是 symlink」这种写法。

`validateCwd()` 要求 cwd 的 realpath 在 root 内，bash 与别的工具都过这一道。

**留白**：校验与真正使用之间存在竞态窗口，返回的是 resolve 后的路径而不是打开后的 fd；硬链接也没查。要完全关掉需要 open-then-verify。当前强度是为单用户本地场景设的。

## URL guard

`assertSafeUrl` 是第一层：协议只允许 http 与 https，主机名字符串过一遍私网与保留网段集合——IPv4 覆盖 loopback、10/8、172.16-31、192.168、169.254、100.64-127、198.18-19、0.0.0.0-8，IPv6 覆盖 `::1`、`fc`、`fd`、`fe80::/10`，以及 IPv4-mapped 的两种写法。

`assertSafeUrlDeep` 是第二层：把主机名解析成 IP，逐个复查，命中即拒。它的注释自己声明不是 TOCTOU 免疫的（解析与实际连接之间仍可能变），但把「用 DNS rebinding 绕过字符串过滤」这条堵住了。

默认的 fetch port 用它护着两处：首跳直接过 deep guard，重定向走手动模式、**每一跳**都重过一遍，上限五跳。回归测试钉住了「重定向到私网被拒」。

browser 工具用同一个 guard，另外单独拒绝 metadata 端点。

**留白**：注入 fetch port 之前的那次预检仍是同步版本，真实约束由 port 内部的 deep 检查承担；MCP 的 url server 挂载前**没有**过 guard（见 [安全与债务清单](./debt.md)）。

## 审批管线

`ApprovalRequest` 的来源有三种：权限、工具、分类器；另外留着 `sandboxed` 字段，当前恒为 false。

超时默认 120 秒，可用 `OMA_APPROVAL_TIMEOUT_MS` 覆盖，静默超时按拒绝处理。无界面模式（print / json）一律拒绝。

ask 模式下如果没配管线，工具调用会被阻断而不是放行；handlers 抛错也阻断。也就是说这条链是 fail-closed 的。

## native 权限门

高风险原生工具是 `bash`、`browser`、`eval`、`write`、`edit`、`learn`、`manage_skill`。以 `mcp__` 开头的工具由前缀单独判定。

auto 模式下，除了上述清单，`mcp__*` 与插件里的代码工具也走分类器；`learn` 只在它要写 agentDir 时才算高风险。整个 auto 分支外面包着 try/catch，异常即阻断。

同一套策略工厂透传给 workflow 的子 agent，所以子 agent 不会绕过门。

yolo 模式明确不做门禁，这是设计：静态边界（工作区范围、受保护文件、凭据剥离、出网、写入新鲜度）依然生效。

**留白**：目前没有 allow-rules 那种细粒度的原生权限系统。

## 插件信任链

`computePluginHash` 对插件目录递归算 sha256，**每个非目录条目都参与**：普通文件按内容、symlink 按 link target、其他类型按标记。这条规则是踩坑之后收紧的——早先版本跳过 symlink 与 `node_modules`，被证明可以换代码绕过。

信任判定就是「记录的 hash 等于当前内容的 hash」，任何改动都会退回未信任。信任文件损坏或缺失时返回空表，等同全部未信任，不抛错。

作用域乘模式的矩阵：project 作用域的代码组件在 RPC 模式**永不加载**，即使已被信任，并给出一条 warning；非 RPC 模式下 workspace 的 `.mcp.json` 未信任时不挂载任何 workspace server，提示用户去 `/mcp trust`。

单文件场景另有 `computeFileHash` / `trustFile` / `isFileTrusted`，用的是同一份信任记录。

## 凭据剥离

子进程拿到的是白名单转发：`PATH`、`HOME`、`LANG`、`TZ`，加上 provider 的 key。父进程其余环境变量（后端 token、宿主机密钥）不会到达 agent 子进程。

bash 侧再剥一层凭据形状的变量，因为有些密钥是通过别的路径进的进程环境。stderr 也会红线化，隐藏 Bearer 形态的串。

哨兵测试在 `apps/oh-my-agent/src/core/runtime/agent-loop-harness-events.test.ts` 与 `bash.test.ts`：把 `sk-sentinel-...` 放进环境，断言它不出现在 store、事件或子进程环境里。

## 每条防线不管什么

- **路径 jail** 管文件工具，不管 bash 命令；bash 的 cwd 过同一道校验，但命令读什么不由它决定。
- **URL guard** 管 `web_fetch` 与 browser，**不管 bash 里跑的 `curl`**，也不管 MCP 的 url server。
- **审批管线**是一道判断闸，不是沙箱：它决定要不要问人，不限制命令本身能做什么。
- **插件信任哈希**防篡改（内容变了就失效），不防内鬼（被信任之后作者想干什么还是能干）。
- **凭据剥离**管环境变量这条通道，不管读 `/proc/<ppid>/environ` 这类旁路（见 [安全与债务清单](./debt.md)）。
