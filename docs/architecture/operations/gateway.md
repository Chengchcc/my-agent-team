---
title: 启动器与升级
description: oma gateway / oma update 这条线：产物怎么打包与安装、版本怎么发现、更新时谁被重启、成品如何自证能启动
tags: [operations, surfaces]
---

# 启动器与升级

一句话：本页是「装好的那一套」的现状——CLI 与 gateway 产物分开安装、版本从 npm dist-tag 发现、`oma update` 把两者一起推进并重启正在跑的那个。

## 范围

覆盖：`oma gateway <动词>` 与 `oma update` 的行为、产物的目录布局与自检、版本发现规则、`up -d` 的 pidfile 与重启语义、以及 TUI 启动时的升级提示。

不覆盖：产品自身怎么跑（见 [系统总览](../system-overview.md)）、后端与 web 的实现（见 [Product Backend 总览](../backend/overview.md)、[Web 端](../surfaces/web.md)）、登录口令的边界（见 [安全模型](../security/overview.md)）。安装步骤与日常命令在仓库根 [README.md](../../../README.md)。

## 实现文件

- `apps/oh-my-agent/src/cli/gateway-commands.ts` — `oma gateway` 六个动词、分离启动、口令轮换
- `apps/oh-my-agent/src/cli/update-command.ts` — `oma update`：判定安装归属、更新产物、重启后台 gateway
- `apps/oh-my-agent/src/core/update/release.ts` — 版本发现：从 npm dist-tag 取最高版本
- `apps/oh-my-agent/src/core/gateway/artifact.ts` — 下载、校验 sha256、解包、`current` 与 `.complete` 标记
- `apps/oh-my-agent/src/core/gateway/supervisor.ts` — 按清单顺序拉起组件、健康门、逆序收掉
- `apps/oh-my-agent/src/core/gateway/daemon.ts` — `up -d` 的 pidfile、日志、停止前的身份确认
- `apps/oh-my-agent/src/core/gateway/doctor.ts` — 装不起来时的逐项诊断
- `apps/oh-my-agent/src/core/gateway/manifest.ts` — `gateway.json` 契约与 `{root}`/`{dataDir}`/`{secret:}` 变量替换
- `scripts/pack-gateway.sh` — 产物的唯一打包者：布局、pty 库、boot smoke、tar.zst 与 SHA256SUMS
- `apps/oh-my-agent/src/modes/tui/tui-mode.ts` — TUI 启动时的升级提示（`checkUpdate` 接缝）

## 两个东西，两个安装者

CLI 是 npm 包（`@chengchenccc/oh-my-agent`，`bun add -g` 装到 `~/.bun`），gateway 产物是 GitHub release 上的 tar.zst（`oma gateway fetch` 解到 `~/.oma/gateway/versions/<版本>/`）。两者**分开安装**，这是有意为之：产物是 25 MB 级别的平台无关包，Bun 默认拦依赖的 postinstall，所以装包不会顺手下载它。代价是它们会不同步，而不同步的典型后果是——CLI 是新的，产物是坏的或旧的，`oma gateway up` 起不来。[排障指南](./troubleshooting.md) 的「打包产物」一节按症状列了这种情况。

`~/.oma` 下的布局：

```
gateway/versions/<版本>/   代码：backend bundle、drizzle 迁移、资源、web、pty 库
gateway/current            文本，指向当前版本
gateway/up.pid, up.log     up -d 的 pidfile 与日志
gateway-data/              数据：SQLite、Agent 工作区、workflow
gateway-secrets.json       登录口令与后端 token（0600）
```

代码与数据分家，所以换版本不动数据。

## 动词

`oma gateway` 的六个动词各自一件事：`up`（前台，Ctrl-C 收）、`up -d`（分离，健康后返回）、`down`（停 `up -d` 起的那个）、`fetch`（只下载校验，幂等）、`status`（版本/进程/健康/口令，只读）、`doctor`（逐项诊断）、`passwd`（换口令）。`up|fetch` 都接受 `--version <版本>`。

`down` 在动手前会确认目标进程真的是本栈的（比对命令行里的 `gateway up`），pid 复用不会让它杀掉无关进程。

## 版本发现

`oma update` 与 TUI 提示都问 `core/update/release.ts`：读 npm 的 `dist-tags`，在 `latest` 与 `rc` 之间取**版本更高的那个**。

不是只看 `latest`：0.2.0 这条线在 rc 期间，`latest` 仍指向更旧的 0.1.1-rc.1，最新的构建在 `rc` 上。等正式版发到 `latest`，它自然胜出。注册表 origin 固定为 `registry.npmjs.org`，与随后按精确版本安装的那一步用同一个目录——否则一个滞后的镜像会给出它还没有的版本，安装随即失败。

## `oma update`

四步，顺序是有理由的：

1. **先产物**：它是「CLI 好着、产物坏了」的那一半，也是 `oma gateway up` 真正需要的东西；这一步失败即整体失败（退出码 1）。
2. **再 CLI 自己**：只在能认出安装者时装。跑在 checkout 里（源码或仓库内的 dist）只提示 `git pull`；全局 bun 安装才跑 `bun add -g`；认不出来的（手工拷的文件、别的包管理器）**只打印该跑什么**，不猜——用错误的安装者去覆盖，会把版本悄悄钉住。这一步失败不致命，产物已经就位。
3. **然后重启后台 gateway**：`up -d` 起的那个记着版本号，版本不同就停掉再按新版本分离启动，并等它健康才返回。前台跑着的那个不归我们管（没有 pidfile），交给用户。
4. 打印收尾。

**不下行降级**：注册表给的是「最新发布」，不一定是本机最新的东西（同一个版本的 checkout、本地构建的包都比它新），所以目标版本比本机还旧时直接停手，`--version` 是显式的绕过方式。

`--check` 只报告不动作，把 CLI 与产物**两条轴分开列**（正是上面说的「会不同步」），有更新时退出码 1——和 `oma gateway status` 用退出码表达状态是同一套口径。

TUI 启动时会异步问一次注册表，有新版本就在转录里放一行 `Update Available` 加 `oma update` 的指引（omp 的同位通知）。这是一次网络往返，所以：不阻塞启动、失败一律当作「没有更新」、`OMA_NO_UPDATE_CHECK` 可关。一次性模式（`-p`/`--mode json|rpc`）不提示，`rpc` 的 stdout 是协议，一次性的输出也不该混进提示。

## 产物怎么自证

`scripts/pack-gateway.sh` 打完包会**从干净工作目录启动一次 backend 并要求 `/health` 应答**，过不了就不产出 tar。这条自检是被一次事故逼出来的：产物少打了 bun-pty 的预编译库，而它在模块加载期就 `dlopen`，于是每个 `oma gateway up` 都在 listen 之前退出——CI 全绿，只有用户起不来。

自检之外还有三条 fail-closed：bun-pty 的库必须在位；除该目录外不许出现 `.so`/`.dylib`/`.node`/`.dll`（平台泄漏）；`gateway.json` 必须是合法 JSON。同类自检也在 `.github/workflows/artifact-probe.yml` 里跑一遍完整验收：解包、用 launcher 的方式启动两半、跑一次 agent Run。

## 不变量

1. 代码与数据分家：换版本只动 `gateway/versions/`，`gateway-data/` 里的 SQLite、工作区、workflow 不动。
2. 版本发现只看 npm dist-tag 里的最高版本（`latest`/`rc`），且与安装用的注册表 origin 一致。
3. `oma update` 不下行降级，除非 `--version` 显式指定。
4. 只重启自己启动的进程：前台 gateway 没有 pidfile，`update` 不碰它；`down` 只杀身份确认通过的 pid。
5. 认不出的安装者不猜：打印命令而不是替它更新。
6. 产物必须自证能启动，boot smoke 不过就不产出 tar。

## 已知缺口

- TUI 之外没有提示：`oma -p`、`--mode json|rpc` 这类一次性调用不查版本（`rpc` 的 stdout 是协议，混提示会破坏它）。要在脚本里判断，用 `oma update --check` 的退出码。
- `oma update` 不校验 CLI 与产物的锁步关系，只按版本号推进——两者版本号不同步时不报警，因为发布流程本身保证锁步（同一个 tag 盖 CLI 版本与产物版本）。
- 认不出安装者时给的那条命令是写死的 `bun add -g`：npm 全局装、brew、mise 这些装法都会被归到「认不出」，不会自动更新。
- 升级只前进不回收：旧版本目录留在 `gateway/versions/` 里（回滚的余地），没有清理策略。

## 相关页

- [排障指南](./troubleshooting.md) — 产物起不来时的症状对照表
- [系统总览](../system-overview.md) — 这套服务在生产里是什么
- [安全模型](../security/overview.md) — 口令与 token 的边界
