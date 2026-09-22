---
title: bash 沙箱
description: bash 的 Null、Bwrap、Seatbelt 三个启动策略与开关来源，以及网络白名单等还没做的部分
tags: [sandbox, security, runtime]
---

# bash 沙箱

`bash` 工具从「只校验 cwd」升级成「由操作系统强制文件系统与网络边界」的实现现状：三个启动策略、开关怎么来、各个平台实际强制了什么，以及还没做的部分。

## 范围

覆盖：`BashSandbox` 注入接口与它的三个实现、平台选择与失败语义、开关来源、pty 覆盖层的交互、审批协作的现状、macOS Seatbelt profile 的当前姿态与未完成项。

不覆盖：文件工具的路径 jail（见 [隔离与安全模型](./overview.md)）、Workflow 脚本节点的进程沙箱（那是另一条链路，见 [Agentic Workflow](../workflow.md)）、审批类型定义（见 [oma 内核防线](./oma-kernel.md)）。

## 实现文件

- `apps/oh-my-agent/src/core/tools/bash-sandbox.ts` — 接口、Null / Bwrap / Seatbelt 实现、profile、选择器
- `apps/oh-my-agent/src/core/tools/bash.ts` — 消费方：cwd 校验、环境剥离、pty 交互、启动
- `apps/oh-my-agent/src/core/runtime/run-runtime.ts` — 装配点与 yolo 强制
- `apps/oh-my-agent/src/core/settings/project-settings.ts` — 开关读取与 RPC 模式白名单
- `apps/oh-my-agent/src/modes/tui/settings-overlay.ts` — TUI 里的开关行
- `apps/oh-my-agent/src/core/loops/condition.ts` — continue-condition 复用同一沙箱
- `apps/oh-my-agent/src/core/tools/bash-sandbox.test.ts` — Seatbelt 修正的证据

## 接口

```ts
interface BashSandbox {
  readonly workspaceRoot: string;
  spawn(command: string, opts: { cwd: string; env?: Readonly<Record<string, string>> }): BashSpawn;
}

interface BashSpawn {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}
```

`kill()` 优先 SIGKILL 并且杀进程组——包装层可能 exec 出子进程，只杀直接子进程会留下孤儿。

## 三个实现

**Null**（默认）是零依赖的直通：`bash -c` 加 `stdin: "ignore"` 与 `detached: true`。detached 在这里的作用是可移植地开一个新会话，让无头命令拿不到控制终端——否则一个 password prompt 会抢走 TUI 的按键。

**Bwrap**（Linux）把根只读挂进去，`/dev` 与 `/proc` 挂上，`/tmp` 用 tmpfs，工作区读写挂载，再 `--unshare-net` 与 `--die-with-parent`。参数顺序有讲究：`--tmpfs /tmp` 会遮住位于 `/tmp` 下的工作区，所以工作区的 bind 必须排在后面。

**Seatbelt**（macOS）把 profile 写到工作区下的 `.oma/.seatbelt-<随机>.sb`，用 `sandbox-exec -f` 启动，退出时删掉 profile 文件。

## Seatbelt profile 的当前姿态

profile 的开头是 `(deny default)`，然后放开：进程操作、**全部文件读**、写入白名单（工作区 realpath、`/private/tmp`、几个设备节点）、`file-ioctl`、`sysctl`、`mach-lookup`，最后 `(deny network*)`。

三条写法是硬性的，代码注释里逐条记了原因：

- `file-ioctl` 绝不能写成 `file-ioctl*`——写成通配会让沙箱静默失效，进程以 65 退出；
- 读要用 `file-read*` 而不是枚举路径，枚举会让 bash 直接 SIGABRT，而且 dyld 的缓存路径随系统版本漂移；
- 设备节点要写字面量，缺了 `2>/dev/null` 会被拒，而且报错方式很隐蔽。

工作区路径先 `realpathSync` 再写进 profile：内核按 vnode 的真实路径匹配，symbolic link 形式的工作区否则写白名单不命中。

结论是：**强制边界只有写集合与网络，读是开放的**（与 Linux 侧的只读根挂载对齐）。

## 开关与失败语义

`enabled` 为假走 Null。Linux 上需要 `bwrap` 在 PATH 里，macOS 上需要 `sandbox-exec`，缺任何一个、或者在别的平台上开启，都**直接抛错**——宁可让 Run 装配失败，也不静默地不加约束地跑。

开关来自工作区的 `.oma/settings.json`。RPC 模式下这个文件只被允许贡献 `bashSandbox` 一个键，其余键一律忽略：工作区文件可以把约束**收紧**，不能把分类器、超时、步数这些改松。

yolo 模式下如果没配沙箱会强制启用它，但这时缺工具只记一条 debug 日志然后降级，不让 Run 失败。

TUI 的设置里有 `bashSandbox` 一行（布尔）。

loop 的 continue-condition 复用同一个沙箱实例；没有沙箱时才退回裸 spawn。

## 与 bash 工具的交互

launcher 缺省是 Null，保持向后兼容。

pty 覆盖层在沙箱激活时**被跳过**：它自己 spawn 裸 `bash -c`，会悄悄把用户选的约束作废，所以这时改走 launcher 的 script-bridge pty（真的被约束），并给出一条 notice。

超时与中断统一走 `kill()`。

## 还没做的

- **网络白名单没有实现**。Seatbelt 只有 `(deny network*)`，bwrap 只有 `--unshare-net`：要么全断网，要么全开，没有「只放行 npm registry 和 github」这条中间档。
- **审批里的 `sandboxed` 信号没接线**。字段存在，但在装配点被硬编码为 false（那里的注释说「因为只有 Null」，而 Bwrap 与 Seatbelt 早已存在）。所以「已沙箱化的命令自动放行、未沙箱化的走审批」这条对齐 Claude Code 的设计没有落地。
- **默认值仍是 Null**。所谓「网络化部署时默认开启」属于目标状态。
- 沙箱内仍可经 `/proc/<ppid>/environ` 读到父进程的环境：bwrap 只 unshare 了网络，没 unshare pid。

清单见 [`../../roadmap.md`](../../roadmap.md)。
