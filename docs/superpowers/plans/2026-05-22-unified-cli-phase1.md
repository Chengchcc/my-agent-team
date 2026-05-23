# Phase 1: 死代码清理 + 改名 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Delete 4 dead files, archive mcp-cli.ts, rename 2 files, clean 3 dead alias exports. bin/ from 5→3 .ts files.

**Architecture:** Pure deletion/renames. No logic changes. Zero risk to running system.

**Tech Stack:** TypeScript, Bun

---

## Task 1.1: Delete dead files

**Files:**
- Delete: `bin/my-agent.ts`
- Delete: `bin/mcp-cli.ts` → archive to `docs/superpowers/specs/_archived/mcp-cli-original.ts.md`
- Delete: `src/interface/cli/headless.ts`
- Delete: `src/interface/cli/stdout-bus.ts`
- Delete: `src/interface/cli/` (empty dir after removals)

- [ ] **Step 1: Archive mcp-cli.ts (don't just delete)**

```bash
mkdir -p docs/superpowers/specs/_archived
```

Add frontmatter header then copy content:
```markdown
---
archived: 2026-05-22
reason: Dead code — never wired to any CLI entry point. Archived as design reference for Phase 4.5 (MCP ext CLI integration via RPC). DO NOT import.
see: docs/superpowers/plans/2026-05-22-unified-cli-phase1.md
---
```

Followed by the original content of `bin/mcp-cli.ts`.

```bash
cp bin/mcp-cli.ts docs/superpowers/specs/_archived/mcp-cli-original.ts.md
# Then prepend the frontmatter block
```

- [ ] **Step 2: Delete dead files**

```bash
rm bin/my-agent.ts
rm bin/mcp-cli.ts
rm src/interface/cli/headless.ts
rm src/interface/cli/stdout-bus.ts
rmdir src/interface/cli/ 2>/dev/null
```

- [ ] **Step 3: Verify no broken imports**

```bash
bun run check:guard
```
Expected: PASS (no one imports these files)

## Task 1.2: Rename files

- [ ] **Step 1: Rename TUI entry**

```bash
mv bin/my-agent-tui-dev.ts bin/my-agent-tui.ts
```

- [ ] **Step 2: Update reference in package.json if bin/my-agent-tui.ts is referenced there. Check `package.json` scripts.**

- [ ] **Step 3: Rename daemon CLI parser**

```bash
mv src/interface/daemon/cli.ts src/interface/daemon/parse-daemon-args.ts
```

- [ ] **Step 4: Update imports referencing the old name**

```bash
grep -rn "interface/daemon/cli" src/ --include='*.ts'
```
Fix any import to point to `./parse-daemon-args` or `./parse-daemon-args.ts`.

- [ ] **Step 5: Type check**

```bash
bun run check:guard
```

## Task 1.3: Clean dead alias exports

**Files:**
- Modify: `src/daemon/cli-commands.ts`

- [ ] **Step 1: Delete alias re-exports at line 70**

Delete this line:
```ts
export { daemonStart as startDaemon, daemonStop as stopDaemon, daemonList as listDaemons }
```

- [ ] **Step 2: Verify no consumers**

```bash
grep -rn "startDaemon\|stopDaemon\|listDaemons" src/ --include='*.ts'
```
Expected: zero hits (only in archived docs/plans, not in src/).

- [ ] **Step 3: Type check**

```bash
bun run check:guard
```

## Task 1.4: Verify dead code scanner

- [ ] **Step 1: Run dead code check**

```bash
bun run check:deadcode 2>&1 | head -10
```
(If no check:deadcode script, skip. The manual grep above is sufficient.)

- [ ] **Step 2: Final verification**

```bash
ls bin/*.ts                    # Should be: my-agent-cli.ts my-agent-daemon.ts my-agent-tui.ts
bun run check:guard            # Zero errors
bun test 2>&1 | tail -3        # All pass
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(p1): dead code removal + rename bin/ and daemon CLI

- Delete bin/my-agent.ts (replaced by bin/my-agent-cli.ts)
- Archive bin/mcp-cli.ts → docs/superpowers/specs/_archived/
- Delete src/interface/cli/ (headless.ts + stdout-bus.ts — dead chain)
- Rename bin/my-agent-tui-dev.ts → bin/my-agent-tui.ts
- Rename src/interface/daemon/cli.ts → parse-daemon-args.ts
- Delete 3 dead alias exports from src/daemon/cli-commands.ts

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```
