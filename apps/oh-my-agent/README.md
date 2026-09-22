# @chengchenccc/oh-my-agent

Oma 是本仓库自研的 Agent 执行引擎：既可**独立交互式 TUI**（默认 `oma` 进入终端界面），也可作为无 UI 的一次性 CLI 被 Product Backend 的 Adapter（`@chengchenccc/adapter-oma-agent`）按**每个 Agent Run** spawn 一次。

```text
Product Backend → Agent Run → Adapter → spawn oma --mode rpc
→ per-Run Runtime → BackendRunOutcome → stdout → child 退出
```

**不是 daemon**（就 Run 执行模型而言）：一个 Run = 一个子进程 = 一个 Runtime = 一个 outcome。没有常驻的 session supervisor，没有 worker pool。同一个包里的 `core/gateway/` 是另一回事——`oma gateway up -d` 确实会起一个 detached daemon，那是它自己的 pidfile 加 supervisor，与 Run 无关。

## TUI

用 `oma`（或 `oma --session <id>`）在终端直接开始交互式会话。

- 流式渲染 assistant / tool 事件
- `ctrl+t` 展开 thinking，`ctrl+o` 展开 tool 详情
- mermaid fence 渲染为终端 ASCII 图
- `/resume` 列表/恢复 session，`/fork <n>` 分支
- 模型选择持久化到项目级 `.oma/settings.json`（standalone TUI 专用；backend→oma 仍以 `agent.yml` 为默认，可被 run 参数覆盖）
- `.oma/settings.json` 里的 `prune` 块显式开启读侧工具输出裁剪（`protectTokens` / `minimumSavings` / `protectedTools`），不配就不裁
- composer loader 实时摘要当前动作（tool intent / thinking 首行）

| Real session | Tools | Mermaid |
|---|---|---|
| <img src="../../docs/screenshots/oma-tui-real.png" width="280" alt="Oma TUI real session" /> | <img src="../../docs/screenshots/oma-tui-tools.png" width="280" alt="Oma TUI tools" /> | <img src="../../docs/screenshots/oma-tui-mermaid.png" width="280" alt="Oma TUI mermaid" /> |

## CLI 模式

| 模式 | 用途 |
|---|---|
| `tui` | 默认；交互式终端会话（一个进程 = N 个 Run 共享一个 session 文件） |
| `print` | 一次 Run；stdout 只有 final assistant text；stderr 日志；非零退出码表示失败 |
| `json` | 一次 Run；stdout 全部事件 JSONL + 恰好一个 terminal outcome 行 |
| `rpc` | 每 Run 一次 `execute` + 可选的 `steer`/`abort`；命令走 stdin，`event`/`outcome`/`response` 走 stdout（严格 LF JSONL，stdout 只承载协议） |

`--mode rpc` 是 Adapter 使用的模式。wire schema 归**本 app 所有**（`src/protocol/`），Adapter 侧保留一份独立的解析/映射副本（`packages/adapter-oma-agent/src/{protocol,event-mapper}.ts`）——两份靠 fixture + `src/protocol/drift.test.ts` 对齐，不共享包（ADR 0024）。改协议：先改这里，再改 adapter 那份，drift 测试会挡住漏改。

## Runtime

`createOmaRuntime()`（`src/core/runtime/create-runtime.ts`）构造一个 Runtime = 一个 Run：

- `run(input)` 返回唯一 segment，其 `outcome` 是 Run 的唯一终态；
- `steer(input)` 注入 live loop；`stop()` 中止；
- `close()` 拆除 MCP clients 与 SessionStore。

Runtime 主体就在本 app 的 `src/core/`：OmaSession（model/tool loop、retry、compaction、插件、todo、tool-result pruning）与 in-memory SessionStore（`core/store/`）。in-memory store 随 Run 销毁，但子进程会把本轮写进自己的 session 文件（`core/session/` 的 JSONL），并通过 outcome 回传 `cliSessionRef`；下一个 Run 用它 resume 那个文件，扁平的历史桥只在没有引用时才用。

## 运行

```bash
bun run --cwd apps/oh-my-agent dev -- -p "hello"    # source CLI (dev)
bun apps/oh-my-agent/src/cli.ts -p "hello"          # source CLI, direct

bun run --cwd apps/oh-my-agent build                # → dist/cli.js (executable)
./dist/cli.js -p "hello"                            # built binary (inside apps/oh-my-agent)

cd apps/oh-my-agent && bun link                     # optional local install
oma -p "hello"                              # then run from anywhere
oma                                     # standalone interactive TUI
```

- 正常由 Backend 通过 `OMA_BIN` spawn（生产：构建后的 `dist/cli.js` 绝对路径；未配置时 Backend 自动用 Bun + 源码入口，dev 无需全局安装或 `bun link`）。
- `dist/cli.js` 带 `#!/usr/bin/env bun` shebang，构建脚本会设置可执行位。

## 目录

```
src/
  cli.ts                可执行入口（shebang + runCli()）
  main.ts               main()/runCli()：参数解析、模式分发、退出码（无 process.exit）
  cli/                  参数解析、初始输入构建、gateway 子命令
  modes/                tui / print / json / rpc 模式
  core/
    runtime/            create-runtime.ts（per-Run Runtime 装配）
    session/            session 文件（JSONL）：/resume、--continue 与跨 Run resume 的持久侧
    settings/           project-settings.ts（.oma/settings.json）
    loops/ goals/ plans/  三种持续模式的状态机与工具面
    gateway/            `oma gateway` 的 daemon、supervisor、doctor、artifact
```

## 相关文档

- [架构 Wiki — Oma](../../docs/architecture/runtime/oma.md)
- [Agent Backend 协议](../../docs/architecture/execution/agent-backend.md)
