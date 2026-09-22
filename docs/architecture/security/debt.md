# 安全与债务清单

本页是安全问题的唯一台账：已经修好的记一条（防止旧洞被重新引入），还开着的逐条列清楚，属于设计取舍的单独标出。每一条都对着代码核过。

## 范围

覆盖：2026-09-07 全仓安全审计的 43 项（H1-H7、M1-M17、Low1-19）在今天的实际状态，2026-08 那两批修复的现存性，以及「明确不修」的取舍与理由。

不覆盖：防线本身的说明（见 [oma 内核防线](./oma-kernel.md)、[隔离与安全模型](./overview.md)、[bash 沙箱](./bash-sandbox.md)）。

## 已经修好的

P0 与 P1 全清。下面按主题记，每条都附实现位置，改坏了门禁或测试会红。

| 问题 | 现状 |
|---|---|
| Elysia 插件作用域的钩子不生效，后端 API 裸奔 | 钩子移到主实例，`app.test.ts` 钉住 401/200 |
| `.mcp.json` 的 `${VAR}` 展开任意环境变量，能外泄 provider key | 改成白名单展开，只注入 run token |
| 插件安装的 `ext::` 传输器 = 安装即 RCE，`-` 开头选项注入 | `source-fetch` 只接受 https/ssh/git@/绝对路径，`-` 开头即拒 |
| grep 的 pattern 走裸 argv，`--pre` 可执行任意命令 | 改成 `rg -n --color=never -e pattern -- path` |
| 5 个 SSR 页只查 cookie 存在性，伪造 cookie 可读全部数据 | 中间件改成真实 HMAC 校验，SSR 布局兜底，启动绑 127.0.0.1 |
| MCP 工具裸名注册，永不匹配 `mcp__` 前缀门控 | 统一注册成 `mcp__<server>__<tool>`，产品工具单独豁免 |
| ask 模式的高危清单漏 `eval`，审批异常会穿透成放行 | `eval` 进清单，ask 分支异常 fail-closed |
| workflow 定义 PUT 不校验即落盘，坏 cron 能清空触发器 | 落盘前跑 `parseWorkflow`，触发同步逐文件隔离 |
| 技能包同步信任包内 `.git/config` 的 origin，`versionRef` 可注入 fetch 选项 | 固定用数据库里的 sourceUrl，`versionRef` 白名单，reset 前复核 rev |
| 知识库内置安装的 name 可以 `../` 拷任意目录 | name 段白名单 |
| git 克隆与 zip 解压不扫 symlink，无配额 | clone 后校验条目，`-Z1`/`-Zl` 失败即拒，预检拒 symlink，50k 文件 / 1GB 配额 |
| 插件信任哈希跳过 symlink 与 node_modules，批准后可换代码 | 哈希覆盖每个非目录条目，symlink 记 link target |
| marketplace 清单里的路径裸 join，等于任意拷贝或删除 | 段白名单加 resolve 包含性校验 |
| `web_fetch` 的 URL guard 只用 hostname 字符串过滤 | 数值区间集合加尾点归一；deep guard 解析后逐地址复查，重定向每一跳复验 |
| artifact 的 `safePath` 前缀缺分隔符；human-task 双 resolve 竞态；`mergeInputs` 的原型污染；eval 无超时上限；sandbox 单发 SIGTERM 不杀树 | 逐条就地修好（条件 UPDATE、键过滤、进程组杀、输出上限） |
| cron 回调未捕获异常会杀掉整个 backend | 回调包 try/catch，测试钉住 |
| 沙箱「硬超时」在 macOS 永久挂死 | 以 `proc.exited` 为完成信号，无 setsid 时递归杀后代，超时后 SIGKILL 升级 |
| `GET /api/settings` 明文返回全部 provider key | 按 key 名深层脱敏；PUT 加可写键白名单 |
| 工作区可写的 `.oma/models.yml` 能劫持 provider baseUrl | 产品子进程带 `OMA_WORKSPACE_CATALOG=0`，只认 `$OMA_HOME` |
| 飞书没有发送者授权，组织内任何人 DM 就能驱动 Agent | 非 `user` 类型的发送者先丢弃，支持发送者白名单 |
| human 答案里的 `nextNode` 能绕过全部 `when` 条件 | resolve 前剥掉 `nextNode` 与原型链键，并用条件 UPDATE 原子认领 |
| JSON-Logic 未知算子 fail-open，笔误能把审批门变无条件 | parse 期就拒绝白名单外的算子 |
| 重复 definition id 泄漏 cron 句柄 | 同步时去重并报警 |
| workflow SSE 队列只增不删 | 取消订阅时摘除并关闭队列，定义流补心跳 |
| glob 可以 `..` 逃出工作区 | 拒绝含 `..` 段或绝对 pattern，扫描结果再过滤一遍 |
| 循环级权限门异常 fail-open | 门内异常即阻断 |
| agent 可写 `.oma/settings.json` 钉死 auto 分类器模型 | RPC 模式只允许它贡献 `bashSandbox` 一个键，且该文件被列为受保护文件 |
| bash 输出无上限可打爆进程 | 两条流各封顶 10 MiB |
| oma 命令 id 冲突、无响应超时 | id 加随机后缀，加有界响应超时 |
| 三个 CLI 适配器的 JSONL 缓冲无界 | 各自加 10 MiB 帧上限 |
| artifact list 的目录守卫写反，逃逸目录被递归 walk | 任何 fs 访问前先拒绝越界目录 |
| 出厂默认凭据 `dev-token` / `admin` 被原样拷贝 | `predev.sh` 对 token 与密码同 `SESSION_SECRET` 一样随机生成并互相同步 |
| 登录限流计数永不衰减，可被永久锁死 | 过期即清理，失败即重置 |

## 还开着的

### MCP 面

MCP 的 stdio CRUD 允许任意 `command` / `args` / `env`，`/test` 会立刻 spawn，`/tools/invoke` 连 body schema 都没有。这是 token 持有者等于宿主机 RCE 的那类问题。单管理员本地工具是既定设计，一旦引入第二个用户立刻不可辩护。

同一条路还有两个问题：`GET /api/mcp-servers/:id` 明文返回 env 与 headers 里的凭据（读侧从不脱敏）；MCP 的 url server 挂载前**没有**过 SSRF guard。

### 其他开放项

| 问题 | 说明 |
|---|---|
| 沙箱超时与重试参数没有上限 | `timeoutMs` 收任意正数，retry 三个参数无界，长任务实际不可取消 |
| provider 密钥明文落盘，文件权限 0644 | `dataDir`、`backend.db`、`backend/.env` 都没有收权限；全仓没有 chmod |
| grep 子进程继承全量父环境 | bash 有凭据剥离，rg 没有，凭据可经 `RIPGREP_CONFIG_PATH` 或 `--pre` 外溢 |
| bash 可经 `/proc/<ppid>/environ` 读父进程环境 | bwrap 只 unshare 网络，没 unshare pid |
| Seatbelt profile 写在 agent 可写的 `.oma/` 下 | 存在「写 profile → exec」的窗口 |
| 文件 jail 是校验后使用，不是 fd 校验 | TOCTOU 与硬链接未处理 |
| `cliSessionRef` 没有形状校验就拼进 session 文件路径 | 值来自数据库，可达性薄，但边界两侧都没强制 |
| human 答案绕过 outputSchema 与表单元数据校验 | 其他节点类型都有这一步 |
| `pathGet` 走原型链；human 的 `timeoutMs` 解析了但从未实施 | 前者是 JSON-Logic 的取路径函数，后者字段一直没用 |
| 执行列表没有分页，批量 resolve 没有条数上限 | 一次大请求能驱动全量 |
| 输入队列路由忽略路径里的会话参数 | 跨会话可改别人的待投递输入 |
| workflow / agent-config 的本地 MCP server 无鉴权 | 只绑 127.0.0.1；同机进程可枚举定义、往编辑器推提案 |
| `/entries` 对 symlink 目录不做 realpath | `/file` 有，列表没有 |
| SSE 没有连接上限，`idleTimeout: 0` | 每订阅还有 5 秒轮询，等于自我 DoS |
| `infra/workspace.ts` 的模板目录无校验 | 当前是死代码 |
| lark-bot 有几处遗留 | `--backend-auth-token` 走 argv（进程列表可见）、PID 复用判定、401 无退避重连、错误串未脱敏 |
| 登录限流在全局桶上，且第 17 条已修但 XFF 未处理 | — |
| BFF 前缀逃逸 | `%2e%2e` 与反斜杠段能逃出 `/api/` 前缀；当前前缀外只有 `/health`，零实际影响 |
| logout 无 CSRF 防护 | 无条件下发清 cookie |
| session 过期时中间件对 `/api/*` 返回 302 | BFF 的 401 分支失效，EventSource 会重连风暴 |

## 明确不修的取舍

这些不是漏掉的，是当前威胁模型（单用户本地，[ADR 0026](../../adr/0026-agent-threat-model.md)）下接受的：

- **无多租户**。21 张表没有租户列，鉴权是单进程共享 token。带 token 就能读全部数据、代答别人的审批。坚持单操作员模型的话，文档与启动提示要写清楚；一旦要多用户，得加 principal 列并逐 feature 过滤。
- **MCP catalog 的 command 不校验就 spawn**。等价于已经接受的 bash 任意执行，增量是持久化并绕过了 oma 的权限门。
- **MCP 凭据明文存在工作区文件里**。完整修复要后端侧的密钥注入链路。
- **后端不校验 Host 与 Origin**。鉴权修好之后 DNS rebinding 拿不到 token，风险大幅降级；可以加 Host 白名单作为纵深防御。
- **workflow 脚本节点是完整进程**，不是文件系统或网络 jail。现在是 opt-in，且在有 bwrap / sandbox-exec 的机器上会加网络与读限制；工具缺失时降级为纯进程隔离并只打印警告。

## 网络化部署的准入门槛

一旦要离开回环地址，下面这些是准入门槛而不是事后补丁：

1. bash 的网络白名单（当前只有全断或全开）；
2. MCP 的 env 与 headers 加密存储，以及 url server 挂载前过 SSRF guard；
3. 移除 mock 登录表面；
4. native 工具的细粒度 allow-rules 权限系统。

（原先列的「URL guard 校验解析后的 IP」已经交付，不再算门槛。）

完整清单与优先级见 [`../../roadmap.md`](../../roadmap.md)。
