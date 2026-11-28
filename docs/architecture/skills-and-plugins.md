---
title: Skills & Plugins
description: Builtin role-scoped skills (11 skills split front/worker), Skill Pack install/sync state machine, progressive skill discovery & frontmatter switches, Oma plugin hooks & trust matrix, and HITL permission modes
tags: [skills, plugins, permissions, oma, backend]
---

# Skills & Plugins

CrewDesk separates **declarative progressive skills** (Markdown `SKILL.md` loaded on demand in two phases across all four harnesses) from **executable Oma plugins** (TypeScript tools and lifecycle hooks governed by a strict scope × mode trust matrix) and **HITL permission gates**.

## Authoritative files

- `skills/` — 11 builtin `SKILL.md` directories (role-scoped via frontmatter)
- `apps/backend/src/features/skill-pack/entities.ts` & `builtin-roles.ts` & `seed.ts` — Pack states, `INSTALL_TRANSITIONS`, role views (`front` / `worker`), crash reaper
- `apps/backend/src/features/skill-pack/service.ts` & `install-session.ts` & `tools.ts` & `http.ts` — Git/ZIP install, TOCTOU-safe git sync, HTTP endpoints
- `packages/config/src/skill-index.ts` — `buildSkillIndex(roots)` (1000-entry cap, symlink escape guard, frontmatter parser)
- `apps/oh-my-agent/src/core/tools/skill.ts` — `progressive-skill` plugin (`## Skills` meta index + `skill_load` tool)
- `apps/oh-my-agent/src/cli/initial-input.ts` & `apps/oh-my-agent/src/core/settings/workspace-context.ts` — Standalone & ACP skill root discovery
- `apps/oh-my-agent/src/core/runtime/plugin.ts` — `Plugin`, 9 `PluginHooks`, `validatePlugins()`, `renderMeta()`, `collectTools()`
- `apps/oh-my-agent/src/core/plugins/plugin-marketplace.ts` & `plugin-resolve.ts` & `plugin-trust.ts` & `plugin-code.ts` — Manifest resolution, SHA-256 trust store, scope × mode matrix
- `apps/oh-my-agent/src/core/runtime/run-permissions.ts` & `approval.ts` & `permission-classifier.ts` — `ask`/`auto`/`deny`/`yolo` gates & LLM classifier

## Builtin Role-Scoped Skills (`skills/`, `builtin-roles.ts`)

Every builtin `SKILL.md` declares optional `roles:` / `role:` frontmatter (`front`, `worker`, `[front, worker]`, or omitted = both):

| Role Scope | Builtin Skills (11 total) |
|---|---|
| `front` (6) | `member_manage`, `project_manage`, `reminder_manage`, `requirement_memory`, `team_dispatch`, `wiki_manage` |
| `worker` (3) | `agent_doctor`, `agent_fanout`, `worker_delivery` |
| Both (2) | `workflow_design` (`roles: [front, worker]`), `skills_about` (omitted → both) |

At boot, `materializeBuiltinRoleViews()` atomically stages filtered directories into `<dataDir>/skill-packs/.builtin-by-role/{front,worker}`. At Run creation (`bootstrap/features.ts`), `skillRoots` is frozen as `[builtinRoleDir, ...readyAssignedPackRoots]` so the role-scoped builtin view always takes precedence.

## Skill Pack Lifecycle (`features/skill-pack/`)

Packs (`skill_pack` + `agent_skill_pack` tables) support three sources: `builtin` (immutable; `DELETE` returns `409 BuiltinPackImmutableError`), `git` (`@chengchenccc/source-fetch`), and `zip` (rejects symlinks and path escapes). Every pack must pass `validatePackDir` (≥1 valid `SKILL.md` with `name:`).

- **State machine (`INSTALL_TRANSITIONS`):**
  - `pending → installing | failed`
  - `installing → ready | failed`
  - `ready → syncing` (git packs only)
  - `failed → installing | syncing`
  - `syncing → ready | failed`
- **Crash reaper (`seedSkillPacks`):** on boot, any non-builtin pack stuck in `pending | installing | syncing` transitions to `failed`; `builtin` is re-materialized whenever its directory fingerprint drifts.
- **TOCTOU-safe Git sync (`POST /api/skill-packs/:id/sync`):** fetches directly from the DB-stored `sourceUrl` (never `.git/config`'s `origin`) with `-c core.symlinks=false` and `assertSafeRef`. When `confirm=false` and `FETCH_HEAD !== installedRef`, returns `409 { code: "upstream_changed", from, to }`. When `confirm=true`, pins `expectedRev` before transitioning to `syncing`; `runSync` aborts if `FETCH_HEAD` moves during confirmation.
- **Routes:** `GET /api/skill-packs{,/lockfile,/validate}`, `POST /api/skill-packs/{git,upload}`, `POST /api/skill-packs/:id/sync`, `DELETE /api/skill-packs/:id`, `GET /api/skill-packs/:id/{skills,files,search}` (search caps at 50 hits and `512_000`-byte files, skipping dotfiles/`node_modules`/symlinks).

## Progressive Skills & Discovery Precedence

`createSkill()` (`apps/oh-my-agent/src/core/tools/skill.ts`) implements two-phase loading so system prompts stay compact:
1. **Index phase:** `buildSkillIndex(roots)` scans up to `MAX_ENTRIES = 1000` entries per root (skipping symlinks escaping the canonical root) and injects only `name` + `description` into the `## Skills` Meta section.
2. **Body phase:** the model calls `skill_load({ name })`, which verifies `isWithinRoot`, strips YAML frontmatter, substitutes `${SKILL_DIR}` with the skill's real directory, and returns `{ name, dir, hint, body }`.

- **Frontmatter switches:**
  - `hide: true` (default `false`): omits the skill from the `## Skills` prompt index while keeping it loadable via `skill_load`.
  - `user_invocable: false` / `disableModelInvocation: false` (and kebab-case variants; all default `true`, ANDed): hides the `/skill:<name>` slash command.
- **Name collision rule:** **earliest root wins**; final index sorted lexicographically.
  - **ACP / Product runs:** `<cwd>/.oma/skills/*` (populated by Workspace Bridge from `[builtinRoleDir, ...readyPacks]`), plus `<agentDir>/managed-skills` appended last on `read_write` workspaces.
  - **Standalone CLI (`resolveStandaloneSkillRoots`):** explicit `.oma/settings.json` `skills[]` if non-empty; otherwise `<ws>/.oma/skills` → `<agentDir>/skills` → optional `.claude`/`.codex`/`.agent(s)` roots → enabled marketplace plugin `skillsDir`s → `<agentDir>/managed-skills` last.

## Oma Plugin System & Trust Matrix (`core/runtime/plugin.ts`, `core/plugins/`)

Plugins are plain objects `{ name, hooks?, tools?, meta? }` validated by `validatePlugins()` (throws on duplicate plugin, tool, or meta-section names).

- **9 lifecycle hooks (`PluginHooks`):** `beforeRun`, `afterRun`, `beforeModel`, `afterModel`, `beforeTool` (can return `{ block, reason }`), `afterTool` (can return `OmaLoopEvent` or `{ content?, isError?, terminate? }`), `transformToolArgs`, `beforeStop(cancel, rt)`, `afterStop(vetoed, rt)`.
- **Precedence:** native tools win over plugin code tools on name collision; injected product MCP `ask_question` and `todo_write` win over `oma`'s native fallbacks.
- **Manifest priority (`loadPluginManifest`):** `plugin.json` → `.claude-plugin/plugin.json` (metadata fallback only) → `package.json` (`name`/`version`/`description`/`skills`). **Executable code entries (`tools`, `hooks`) are read exclusively from `plugin.json`**; Claude/omp/pi hook/code blocks are ignored with warnings.
- **Scope × Mode trust matrix (`plugin-resolve.ts`, `plugin-trust.ts`):**
  - Registry location pins `scope` (`<agentDir>/plugins.json` = `"user"`, `<workspace>/.oma/plugins.json` = `"project"` — a project registry can never claim `"user"`).
  - Trust store `<agentDir>/trusted-plugins.json` records recursive content+symlink SHA-256 hashes (`computePluginHash`); any file change invalidates trust; corrupt files fail closed to untrusted.

| Source | `tui` / `print` / `json` | `acp` / `rpc` (Product) | `permissionMode === "deny"` |
|---|---|---|---|
| `scope: "user"` plugin code & `.mcp.json` | Allowed | Allowed | Code skipped before `import()` |
| `scope: "project"` plugin code & `.mcp.json` | Allowed **only** if SHA-256 trusted (`/plugin trust`) | **Blocked** (never loaded) | Blocked |
| Workspace `.mcp.json` | Allowed **only** if file SHA-256 trusted (`/mcp trust`) | Allowed (written by Backend Workspace Bridge) | Tools gated by `deny` |

`loadPluginCode()` verifies `realpathSync(file)` remains inside `realpathSync(root)` and catches all import errors so broken plugins degrade gracefully without crashing the Run.

## HITL Permission Modes (`run-permissions.ts`, `permission-classifier.ts`)

| Mode | Behavior |
|---|---|
| `ask` | Prompts human on high-risk tools (`bash`, `browser`, `eval`, `write`, `edit`, `orchestrate`, `learn`, `manage_skill`, `mcp__*`, plugin code tools). Exempts `OMA_CONSENTED_MCP_TOOLS`. Headless `print`/`json` use `denyAllApprovals`. |
| `auto` | Runs deterministic `isCriticalDeletion()` circuit breaker (blocks `rm`/`rmdir` on `/`, `~`, `$HOME`, system roots) + LLM classifier (`OMA_PERMISSION_CLASSIFIER_MODEL`, 30s timeout, fail-closed, 1 retry on no verdict, user-only context, truncates inputs >8000 chars) for effect-escaping tools; max 1 human escalation per unique `toolName:JSON(input)`. |
| `deny` | Blocks all high-risk tools and drops all `codePlugins` before `import()`. |
| `yolo` | Skips judgment gates, **force-enables OS bash sandbox** when available, and still obeys backend-injected `OMA_DENY_WRITE_PATHS` / `OMA_ALLOW_WRITE_PATHS` / `OMA_DENY_COMMANDS`. Untrusted `.oma/settings.json` requesting `yolo` downgrades to `ask`. |

`allow_always` / `deny_always` decisions are strictly Run-scoped. Approval deadline defaults to `24h` (`OMA_APPROVAL_TIMEOUT_MS`, `0` = wait indefinitely) and fails closed on timeout/cancel/error.

## See also

- [Oma Runtime](./oma-runtime.md) — How `assembleRunRuntime()` wires plugins, tools, and gates
- [Workspaces & Projects](./workspaces-and-projects.md) — Workspace Bridge skill symlinks and `.mcp.json`
- [Security Model](./security-model.md) — Path jail, bash sandbox, and untrusted workspace rules
