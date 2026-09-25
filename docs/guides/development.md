# 开发环境

本页是本地开发环境与仓库命令的权威说明：从 clone 到能跑、到能提交，中间那些脚本做了什么。

## 范围

覆盖：首次准备、`bun run dev` 背后的动作、各个脚本入口、门禁命令、小内存机器上的注意事项。

不覆盖：装一个能用的发行版（见仓库根 [`README.md`](../../README.md)）、架构（见 [`../architecture/`](../architecture/README.md)）、出问题怎么查（见 [`./troubleshooting.md`](../architecture/operations/troubleshooting.md)）。

## 实现文件

- `scripts/predev.sh` — `dev*` 之前跑的幂等准备：生成迁移、建 `.env`、生成密钥、拷 Monaco
- `scripts/dev.sh` — 同时起 backend 与 web，Ctrl-C 一起收
- `scripts/gen-drizzle.sh` — 重新生成 drizzle 迁移（迁移目录不进版本库）
- `scripts/memguard.sh` — 给重命令套 cgroup 内存上限
- `packages/config/src/env.ts` — 所有进程的环境变量 schema，唯一的定义处
- `apps/backend/.env.example` / `apps/web/.env.example` — `.env` 模板

## 首次准备

需要 Bun 1.3 以上，然后：

```bash
bun install
bun run dev
```

`bun run dev` 先跑 `predev.sh`，再跑 `dev.sh`。两个常驻服务分别是 Web（`http://localhost:3001`）和 Backend（`http://localhost:3000`），登录页在 `/login`。

`predev.sh` 做四件幂等的事，每件都只在缺的时候动手：

- 迁移的 journal 不在就调 `scripts/gen-drizzle.sh` 生成。迁移文件本身是**提交进版本库**的（`apps/backend/drizzle/backend/`、`apps/lark-bot/drizzle/`），CI 会用这个脚本核对「schema 改了但没重新生成迁移」；正常 clone 里这一步是空操作。
- `apps/backend/.env` 和 `apps/web/.env` 缺了就从 `.env.example` 复制。
- 生成 `BACKEND_AUTH_TOKEN`（`openssl rand -hex 24`）写进 backend 的 `.env`，再把同一个值镜像进 web 的 `.env`；顺手生成 `SESSION_SECRET` 和 `MOCK_PASSWORD`（22 位，字母表剔掉了 `l/1/I/O/0`），最后把 web 的 `.env` 权限收成 `0600`。这两个 `.env` 里的 token 必须一致，否则 BFF 调后端全是 401。
- 把 `node_modules/monaco-editor/min/vs` 拷到 `apps/web/public/monaco/vs`。Workflow 编辑器和只读文件预览从本地 `/monaco/vs` 加载，不走 CDN。

`dev.sh` 会先杀掉 3000 和 3001 上的残留进程，再校验 backend 的 `.env`：

- 必须有 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，否则直接退出。注意这是 `dev.sh` 自己的要求，不是后端的要求——`packages/config/src/env.ts` 里唯一必填的变量是 `BACKEND_AUTH_TOKEN`，各家 provider 的 key 都是可选的，缺了只是那个 provider 不能用。
- `BACKEND_AUTH_TOKEN` 还是字面量 `dev-token` 时警告一句。

分开起也行：

```bash
bun run dev:backend     # 只起后端；先构建它依赖的工作区包
bun run dev:web         # 只起 web
bun run oma             # 源码方式跑 oma CLI
```

`bun run dev:backend` 和 `bun run dev:web` 同样先跑 `predev.sh`，但不走 `dev.sh` 的那两条校验。

Web 的登录口令是 `apps/web/.env` 里的 `MOCK_PASSWORD`，由 `predev.sh` 随机生成。要知道当前值就直接看那个文件。

## 命令地图

| 命令 | 做什么 |
|---|---|
| `bun run build` | turbo 全量构建 |
| `bun run typecheck` | 各包自己的 typecheck，逐包跑 |
| `bun run lint` | Biome 加各包的 ESLint |
| `bun run test` | 各包 `bun test` |
| `bun run format` | Biome 格式化全仓 |
| `bun run audit` | 契约、工作区、文档、UI 四道快速门禁 |
| `bun run audit:coverage` | oma 内核与 backend 的覆盖率下限（约一分钟） |
| `bun run quality:mutate` | 变异探针：故意改坏一处行为，看测试是否变红；一次跑一遍全量测试，按需跑 |

typecheck 有个容易踩的地方：backend 的 `bun run typecheck` 用的是 `tsconfig.test.json`，把测试文件也算进去；直接用 `tsc -p tsconfig.json` 只覆盖源码。测试桩里的字段缺一个或者参数类型收窄了，在本地不会报，到了 CI 才红。本地一律用 `bun run typecheck`。

门禁之间也有类似的分工：本地只 lint 改动文件会漏掉全量规则（比如 `no-useless-assignment`），提交前跑一次全量的 `bun run lint`。

## 小内存机器

`next build` 这类构建在 2 核 / 3.5G 上不会失败，会把机器拖进 swap 抖动，表现为长时间没有输出、内存打满。要跑就用 memguard 套一层：

```bash
bash scripts/memguard.sh --limit 6G -- bun run build   # size the cap to `free -m`: the stack alone idles at 4-5GB
```

它用 cgroup v2 把整棵进程树一起 OOM 掉（`memory.oom.group=1`），所以得到的是「命令被杀」而不是「机器卡死」。发行版构建交给 CI。

## 生成的、不进版本库的东西

这些东西在 clone 之后不存在，由脚本或首次启动补齐，不手动改：

- `apps/{backend,web}/.env` — 本地密钥
- `apps/web/public/monaco/vs` — Monaco 资产
- `apps/backend/.backend-data/` — 本地数据目录：SQLite 库、Agent 工作区、workflow 定义
- `apps/oh-my-agent/dist/` — 构建产物

## 登录口令

控制台的登录口令存在数据目录的数据库里（`settings` 表的 `auth.password_hash`，argon2id）。`apps/web/.env` 里的 `MOCK_PASSWORD` 只是**引导凭据**：某个数据目录第一次启动时，后端把它写成哈希，之后就与这个环境变量无关了。知道口令从哪来、丢了怎么找回：

```bash
grep MOCK_PASSWORD apps/web/.env          # 只对从未启动过的数据目录有效
bash scripts/reset-login-password.sh      # 忘了：清掉哈希，重置成 .env 里的值
bash scripts/reset-login-password.sh 'new-password-1234'   # 或者指定一个新值
```

重置脚本会删掉库里的哈希并把选定的值写回 `.env`，重启后端生效。走 `oma gateway` 装的那套用 `oma gateway passwd`（gateway 在跑就直接推给后端，没跑就清哈希）。原理见 [安全模型](../architecture/security/overview.md)。

## 提交规范

提交信息走 commitlint 的 conventional 规则（`commitlint.config.mjs`），pre-commit 跑 Biome，pre-push 跑 lint。三条硬约束：

- 必须有 scope，且只能从配置里那张清单选：包名（`backend`、`oh-my-agent`、`ai`、`message`……）、应用名（`web`、`lark-bot`）、功能名（`agent-run`、`workflow`、`sandbox`、`mcp`、`settings`）、或者 `docs`、`test`、`lint`、`build`、`deps`、`repo`。不在这张表里的 scope 一律被拒。
- type 只能是 `feat`、`fix`、`refactor`、`perf`、`style`、`test`、`docs`、`chore`、`ci`、`revert`。
- 提交信息里不许出现中文（自定义的 `no-cjk` 规则，header 和 body 都查）。

husky 的 pre-commit 会先 `biome format` 再 `git add -u`，把已跟踪文件的全部改动塞进这一次提交。要拆开提交就先 `git stash push -- <paths>`（未跟踪的文件不受影响）。

## 相关页

- [排障指南](../architecture/operations/troubleshooting.md) — 起不来、连不上、跑不动时按层查
- [Product Backend 总览](../architecture/backend/overview.md) — 后端启动时装了什么
- [依赖注入](../architecture/foundations/dependency-injection.md) — 组装点和注入手法
