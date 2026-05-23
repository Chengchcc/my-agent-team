# PR2: W4 — Slash 系统迁移（删除 application/commands/）

> Pure mechanical migration. Zero behavior change. ~15 file moves + 6 type renames + ~30 import updates.

**Goal:** Delete `src/application/commands/` entirely. Migrate 7 builtin slash commands to `slash/builtin/`. Introduce `SlashRegistry` class + `SlashCommand` type. Update App.tsx and all consumers.

---

## File Map

### Delete (entire directory)
```
src/application/commands/
  command-registry.ts
  command-groups.ts
  parse-command.ts
  types.ts
  builtin/clear.ts
  builtin/compact.ts
  builtin/cost.ts
  builtin/daemon.ts
  builtin/exit.ts
  builtin/help.ts
  builtin/tools.ts
```

### Create
```
src/extensions/frontend.tui/slash/
  slash-registry.ts      ← new SlashRegistry class
  slash-groups.ts         ← from command-groups.ts
  slash-args.ts           ← from parse-command.ts
  builtin/slash-clear.ts
  builtin/slash-compact.ts
  builtin/slash-cost.ts
  builtin/slash-daemon.ts
  builtin/slash-exit.ts
  builtin/slash-help.ts
  builtin/slash-tools.ts
```

### Modify
```
src/extensions/frontend.tui/slash/slash-types.ts   ← merge types from application/commands/types.ts
src/extensions/frontend.tui/App.tsx                 ← replace CommandRegistry with SlashRegistry
src/extensions/frontend.tui/hooks/use-command-input.ts ← update imports
```

### Type renames
| Old | New |
|---|---|
| `CommandDefinition` | `SlashCommand` |
| `CommandGroup` | `SlashGroup` |
| `ParsedCommand` | `ParsedSlash` |
| `CommandExecutionContext` | `SlashContext` |
| `CommandResult` | `SlashResult` |
| `CommandRegistry` | `SlashRegistry` |

---

## Tasks

### 1. Migrate types → slash-types.ts
Read `application/commands/types.ts`, merge into `slash/slash-types.ts` (already has SlashCommand, SlashResolution). Add SlashContext, ParsedSlash, SlashGroup types. Use renamed types.

### 2. Create slash-registry.ts (SlashRegistry class)
Based on `application/commands/command-registry.ts`. Add `register()`, `get()`, `list()`, `resolve()`, `unregisterByGroup()` methods.

### 3. Create slash-groups.ts + slash-args.ts
Migrate from command-groups.ts and parse-command.ts with renamed types.

### 4. Migrate 7 builtins → slash/builtin/slash-*.ts
Rename each builtin file. Update type references from CommandDefinition→SlashCommand, etc.

### 5. Update App.tsx
Replace all CommandRegistry/CommandDefinition imports with SlashRegistry/SlashCommand from slash/. The toSlashCommands helper that converts skill names should also use SlashCommand type.

### 6. Update use-command-input.ts
Update SlashCommand import path (already from slash/slash-types.ts since Phase 1.5).

### 7. Delete application/commands/ directory

### 8. Verify
```bash
bun run check:guard    # zero type errors
bun test               # all pass
grep -rn 'CommandRegistry\|CommandDefinition' src/ --include='*.ts' --include='*.tsx'  # zero hits
```

Commit at end.
