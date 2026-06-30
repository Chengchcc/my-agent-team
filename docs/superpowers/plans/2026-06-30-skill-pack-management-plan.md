# Skill Pack Management 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现技能包管理——安装/同步由 **builtin 技能 + 原子工具 + 临时 AgentSession** 驱动，LLM 自主处理 git 冲突等 corner case。配套 spec：`docs/superpowers/specs/2026-06-30-skill-pack-management.md`。

**Baseline（HEAD `f9793896`）:** backend typecheck 0 error；progressive-skill 引擎已就位；仓库无 `SKILL.md` / `skills/` 目录。

**关键架构决策（2026-06-30 grilling session 决议）：**

| 决议 | 影响 |
|------|------|
| 安装/同步由 Agent 驱动，不做硬编码 TypeScript 流水线 | P3 原子工具 + builtin 技能；P6 安装 session |
| `installPath` 由 `id + dataDir` 推导，不存表 | P1/P2 |
| `roots[]` = pack ID（相对路径），非绝对 installPath | P6 |
| DI：预解析 roots 传入 `BuildSessionSpecParams` | P6 |
| 删 `agent_skill_pack.enabled` 列 | P2 |
| `name + description` 为用户导入参数 | P1/P5 |
| builtin 在 repo 根 `skills/`，seed copy，仅新建 agent 默认 assign | P4 |
| bootstrap reaper 清除非终态 | P4 |
| git symlink 不额外拒绝（依赖 permissionMode + cwd） | P3 |
| sync 手动触发，`invalidateSkillCache` 强制失效，in-place 修改 | P1/P3 |
| multipart 50MB，zip bomb 500MB | P5 |
| 文件浏览复用 `loadSkillIndexWithMtimeCache` + `ws.list/ws.read` | P5 |
| 懒加载目录树 | P5/P7 |
| 卡片 + 抽屉（技能清单→目录树→文件）+ sync 按钮 | P7 |

**PR 切分（7 PR）：**

| PR | 范围 | Task | 风险 |
|----|------|------|------|
| PR-A | 实体 + 迁移 + Port + adapter | Task 1、2 | 低 |
| PR-B | 原子工具 + builtin 安装技能 + Service | Task 3、4 | 中 |
| PR-C | builtin 物理内容 + seed + reaper | Task 5 | 低 |
| PR-D | HTTP 契约（含 multipart + 文件浏览） | Task 6 | 中 |
| PR-E | session-factory + 安装 session | Task 7 | 中 |
| PR-F | 前端（卡片 + 抽屉 + sync 按钮 + AgentForm） | Task 8 | 低 |
| PR-G | 文档 | Task 9 | 低 |

---

## Task 1：技能包实体 + 状态空间（P1）

**Files:**
- Create: `apps/backend/src/features/skill-pack/entities.ts`

- [ ] **Step 1：写 entities.ts**
  - `SkillPackRow`（`id name description sourceKind sourceUrl versionRef installedRef status error createdAt updatedAt`）。**无 `installPath`**。
  - `SkillPackStatus = 'pending'|'installing'|'ready'|'failed'|'syncing'`。
  - `SkillPackSource = 'builtin'|'git'|'zip'`。
  - `INSTALL_TRANSITIONS`：`pending→installing`、`installing→ready|failed`、`failed→installing`、`ready→syncing`、`syncing→ready|failed`、`failed→syncing`。
  - `AgentSkillPackRow`（`agentId packId createdAt`）。无 `enabled`。
  - `applyInstallTransition(cur, next, patch?)`：非法转移抛错；`syncing` 仅 `sourceKind='git'` 合法。
  - `BUILTIN_PACK_ID = 'builtin'` 常量。

- [ ] **Step 2：typecheck** — `(cd apps/backend && bun run typecheck)` exit 0。
- [ ] **Step 3：commit**

**Acceptance:** 状态机完整（含 syncing，仅 git）；非法转移被拒；typecheck 0 error。

---

## Task 2：迁移建表 + Port + SQLite adapter（P2，TDD）

**Files:**
- Modify: `apps/backend/src/infra/db/schema.ts`
- Create: `apps/backend/drizzle/backend/00XX_skill_pack.sql`
- Create: `apps/backend/src/features/skill-pack/ports.ts`
- Create: `apps/backend/src/features/skill-pack/adapter-sqlite.ts`
- Create: `apps/backend/src/features/skill-pack/adapter-sqlite.test.ts`

- [ ] **Step 1：schema.ts 加 `skillPack` + `agentSkillPack` 两表**
  - `skillPack`：按 P1 字段（无 installPath；有 description）。
  - `agentSkillPack`：复合主键 `(agentId, packId)`，仅三列（无 enabled）。

- [ ] **Step 2：生成迁移 SQL + 登记 `BACKEND_MIGRATIONS`。**

- [ ] **Step 3：ports.ts**
  - `SkillPackPort`：`register / get / list / applyInstallTransition / setInstalled / remove`。
  - 分配：`listForAgent / setAgentPacks / removeAgentPack`。

- [ ] **Step 4：先写测试（TDD）** → **Step 5：确认 FAIL** → **Step 6：写 adapter**（读时拼 `installPath` 方便上层） → **Step 7：PASS + typecheck** → **Step 8：commit**

---

## Task 3：原子工具套件 + builtin 安装技能（P3-a，TDD）

**Files:**
- Create: `apps/backend/src/features/skill-pack/tools.ts`
- Create: `apps/backend/src/features/skill-pack/tools.test.ts`
- Create: `skills/skill-pack-installer/SKILL.md`

### Part A：原子工具

- [ ] **Step 1：写 tools.ts** — 6 个工具，cwd 锁定 `<dataDir>/skill-packs/`：

| 工具 | 实现 |
|------|------|
| `pack_git_clone({ url, ref?, targetDir })` | spawn `git clone --depth 1 [--branch ref] <url> <cwd>/targetDir` → parse commit |
| `pack_unzip({ bufferB64, targetDir })` | 解包 base64 → 逐条 `assertSafeEntry`（拒绝 `..`、绝对路径）→ sha256 |
| `pack_git_sync({ targetDir, ref? })` | `<cwd>/targetDir` 内 `git fetch origin [ref] && git reset --hard FETCH_HEAD` → parse commit |
| `pack_validate({ targetDir })` | 调用 `loadSkillIndexWithMtimeCache(ws, [targetDir])` → 至少一个合法 skill → `{ valid: true/false }` |
| `pack_atomic_rename({ tmpDir, finalDir })` | `mv <cwd>/tmpDir <cwd>/finalDir` |
| `pack_update_status({ packId, status, installedRef?, error? })` | 调用 `applyInstallTransition(packId, status, { installedRef, error })` |

每个工具 `targetDir` 校验：不含 `/`、不空、不为 `..`。

- [ ] **Step 2：先写测试（TDD）**
  - git clone → 产出 commit。
  - unzip → 产出 checksum。
  - validate → 合法包返回 `{ valid: true }`；空目录 → `{ valid: false }`。
  - zip-slip → unzip 抛错。
  - update_status → 合法转移成功；非法转移抛错。
  - rename → 文件到位。
  - 所有工具拒绝 `targetDir` 含 `/` / `..`。

- [ ] **Step 3：FAIL → PASS + typecheck。**

### Part B：builtin 安装技能

- [ ] **Step 4：写 `skills/skill-pack-installer/SKILL.md`**
  - YAML frontmatter：`name: skill-pack-installer`、`description: 安装、同步、管理技能包。`
  - 正文指导 agent 如何使用 6 个工具完成安装/同步流程。
  - 错误处理策略：dirty tree → stash 后重试；diverged → reset --hard；网络 → 重试 3 次后报 failed。
  - 提示 `${SKILL_DIR}` 可用于后续脚本引用。

- [ ] **Step 5：commit**

**Acceptance:** 6 个工具测试全绿；SKILL.md 含合法 frontmatter + 正常流程 + 错误处理指导。

---

## Task 4：SkillPackService（P3-b，TDD）

**Files:**
- Create: `apps/backend/src/features/skill-pack/service.ts`
- Create: `apps/backend/src/features/skill-pack/service.test.ts`
- Create: `apps/backend/src/features/skill-pack/index.ts`

- [ ] **Step 1：先写 service 测试（TDD）**
  - `installFromGit/Zip`：`register(pending)` 后被调用 → 断言创建了安装 session（用 fake session factory）。
  - `syncGit`：`applyInstallTransition(syncing)` 后被调用 → 断言创建了 session。
  - `uninstall(builtinId)` → `BuiltinPackImmutableError`。
  - `uninstall(userPackId)` → 删目录 + 级联清分配。
  - `setAgentPacks(agentId, ids)` → 覆盖式写入。

- [ ] **Step 2：FAIL。**
- [ ] **Step 3：写 service.ts**
  - `installFromGit/Zip`：`register` → `createInstallSession`（pass `packId` + `sourceUrl` + `versionRef` + `sourceKind`）→ fire-and-forget prompt。
  - `syncGit`：`applyInstallTransition(syncing)` → `createInstallSession` → fire-and-forget。
  - `createInstallSession(packId, ctx)`：组装 AgentSession（builtin skill + 6 原子工具 + sharedFs + 临时 cwd），prompt 含安装上下文。maxSteps=20。
  - 后置校验：session 结束后检查 `installPath` 存在 + `validatePackDir` 通过 → 确保 `ready`。失败则标 `failed`。
  - `uninstall`：builtin guard + 删目录 + 级联清。
- [ ] **Step 4：PASS + typecheck。**
- [ ] **Step 5：commit**

**Acceptance:** 异步安装/同步语义正确；session 创建含正确上下文；builtin 卸载被拒；typecheck 0 error。

---

## Task 5：builtin 包物理内容 + 启动 seed + reaper（P4）

**Files:**
- Create: `skills/skill-pack-installer/SKILL.md`（Task 3 已完成）
- Create: `skills/<example>/SKILL.md`
- Create: `apps/backend/src/features/skill-pack/seed.ts`
- Modify: backend bootstrap（main 装配处）
- Modify: `apps/backend/src/features/agent/agent.service.ts`

- [ ] **Step 1：写示例技能** — `skills/<example>/SKILL.md`，含合法 frontmatter + `${SKILL_DIR}` 引用。
- [ ] **Step 2：写 seed.ts**
  - Bootstrap 时若无 builtin 记录 → copy `skills/` → `<dataDir>/skill-packs/builtin/` → 登记 `status=ready`。
  - **Reaper**：`status IN ('pending','installing','syncing')` → `failed`。
- [ ] **Step 3：新建 agent 默认 assign builtin** — `agent.service.create` 内 `assign(builtinId)`。
- [ ] **Step 4：手动起后端验证 seed 落盘 + reaper + record。**
- [ ] **Step 5：commit**

**Acceptance:** 首次启动 seed builtin（含 installer + example 技能）且 ready；重启幂等；reaper 清死记录；新建 agent 带 builtin。

---

## Task 6：HTTP 契约（P5）

**Files:**
- Create: `apps/backend/src/features/skill-pack/http.ts`
- Modify: `apps/backend/src/features/agent/http.ts`（分配子路由）
- Modify: router / main 装配

- [ ] **Step 1：http.ts**
  - `GET /api/skill-packs` → 列表。
  - `POST /api/skill-packs/git` → `{ name, description, url, ref? }` → service.installFromGit。
  - `POST /api/skill-packs/upload` → multipart（Elysia `t.File`，bodyLimit 50MB）+ `name` + `description` → service.installFromZip。
  - `POST /api/skill-packs/:id/sync` → service.syncGit。
  - `DELETE /api/skill-packs/:id` → builtin→409。
  - `GET /api/skill-packs/:id/skills` → 复用 `loadSkillIndexWithMtimeCache(sharedFs, [packId])`。
  - `GET /api/skill-packs/:id/files?path=...` → `path` 空列顶级 entries `{ type:'dir'|'file', name }`；`path` 指文件读内容 `{ type, content, path }`。`assertSafeEntry` 防穿越。

- [ ] **Step 2：agent 分配** — `GET/PUT /api/agents/:id/skill-packs`。

- [ ] **Step 3：装配 + 鉴权 + typecheck + 既有测试不回归。**
- [ ] **Step 4：commit**

**Acceptance:** 全端点 curl 验证；typecheck 0 error。

---

## Task 7：session-factory 装配 + 安装 session（P6）

**Files:**
- Modify: `apps/backend/src/features/span/session-factory.ts`
- Create: `apps/backend/src/features/span/skill-roots.ts`
- Modify: `apps/backend/src/features/skill-pack/service.ts`（安装 session 创建）

- [ ] **Step 1：skill-roots.ts**
  - `buildSkillRoots(agentId, skillPackPort, dataDir)`：创建 `nodeFsAdapter(join(dataDir, 'skill-packs'))` → `listForAgent` → `roots=[builtinId, ...otherIds]`（pack ID 相对路径）→ `{ ws, roots, posixSkillRoot }`。
  - builtin 恒在最前。

- [ ] **Step 2：改 session-factory**
  - `buildSessionSpec` 加 `skillRoots` 参数（由调用方预解析后传入）。**不注入 `skillPackPort` 到 `SessionFactoryDeps`**。
  - 替换 `progressiveSkillPlugin({ cwd })` 为 `progressiveSkillPlugin(skillRoots)`。
  - 装配时 warn 记录同名覆盖。

- [ ] **Step 3：安装 session 创建**（service.ts 的 `createInstallSession`）
  - 独立创建函数，不进入 session-registry。
  - 使用与 `progressiveSkillPlugin` **不同的 roots**——仅 `[builtinId]`（安装 agent 只需 installer 技能，不需要目标包的内容）。
  - 工具集 = 6 个原子工具（Task 3）+ 模型基础工具（bash 可选，取决于 agent 是否需要 stash/clean）。
  - cwd = `<dataDir>/skill-packs/`（与 sharedFs root 一致）。
  - maxSteps = 20。

- [ ] **Step 4：typecheck + 手测安装链路。**
- [ ] **Step 5：commit**

**Acceptance:** 分配生效于新建 session；roots 为 pack ID 相对路径；builtin 在最前；安装 session 独立创建、不含目标包技能；typecheck 0 error。

---

## Task 8：前端（P7）

**Files:**
- Create: `apps/web/src/components/SkillPackManager.tsx`（卡片 + 表单）
- Create: `apps/web/src/components/SkillPackDrawer.tsx`（技能清单 → 目录树 → 文件阅读）
- Modify: `apps/web/src/components/AgentForm.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1：typed API client** — 全端点 treaty 类型。
- [ ] **Step 2：SkillPackManager 卡片页**
  - 卡片展示 name / description / source / status / installedRef / 时间。
  - Git 安装表单（name + description + URL + ref）。
  - ZIP 上传（文件 + name + description）。
  - **同步按钮**（仅 git && status=ready）。
  - 安装中/syncing 轮询。
  - 卸载（builtin 禁用）。
- [ ] **Step 3：SkillPackDrawer** — 点卡片 → 抽屉 → `GET /skills` 技能清单 → 点技能 → `GET /files` 懒惰目录树 → 点文件 → 代码高亮。
- [ ] **Step 4：AgentForm 多选分配区。**
- [ ] **Step 5：web typecheck + 手测。**
- [ ] **Step 6：commit**

**Acceptance:** 全流程闭环：安装 → 浏览 → 同步(git) → 分配 → 卸载。

---

## Task 9：文档翻态（P8）

**Files:**
- `CONTEXT.md`（已更新）
- Create: `docs/architecture/plugins/skill-pack.md`

- [ ] **Step 1：写 skill-pack.md** — Karpathy 风格：技能包本体、生命周期状态机、agent 驱动安装 vs 硬编码流水线的 trade-off、装配链路 mermaid、共享落盘理由。
- [ ] **Step 2：交叉链接 progressive-skill + session-factory。**
- [ ] **Step 3：commit**

---

## 收敛后预期终态

| 检查项 | 目标 |
|--------|------|
| 实体/迁移/adapter | 两表（无 installPath / enabled），adapter 测试全绿 |
| 原子工具 | 6 工具，cwd 锁定，zip-slip 拒绝，状态转移校验 |
| builtin 技能 | `skill-pack-installer` SKILL.md，含 happy path + error 策略 |
| 安装/同步 | agent 驱动：git/zip→ready，sync→ready；corner case 由 LLM 处理 |
| builtin + reaper | seed 即 ready（含 installer+example 技能），新建 agent 默认带；启动清死记录 |
| HTTP | CRUD + multipart(zip) + sync + 文件浏览 + agent 分配 |
| 运行时 | 预解析 roots（pack ID 相对路径），builtin 在前；安装 session 独立 |
| 前端 | 卡片 + 抽屉（清单→树→文件）+ sync 按钮 + AgentForm |
| backend typecheck | 0 error |

## 不在本 plan 范围

活 session 热重载、版本回滚/多版本、技能市场、包内脚本细粒度沙箱、私有 git 凭据托管 UI、自动同步。
