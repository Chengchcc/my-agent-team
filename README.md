# my-agent-team

Bun + Turborepo monorepo for Node/Bun TypeScript packages.

## Workspace layout

```txt
apps/       Application workspaces
packages/   Shared package workspaces
_template/  Source templates used by repository scripts
scripts/    Repository automation scripts
```

`apps/**` and `packages/**` are managed by Bun workspaces. `_template/**` is not a workspace.

## Commands

```bash
bun install
bun run format
bun run lint
bun run typecheck
bun run test
bun run build
```

## Create a package

Run the interactive generator:

```bash
bun run create
```

The generator asks whether to create under `apps` or `packages`, then asks for a directory name, package name, and description.

Generated packages are TypeScript ESM libraries for Node/Bun. They build to `dist/` with declaration files.

## Package scripts

Each generated package provides:

```bash
bun run build
bun run lint
bun run test
bun run typecheck
```

The root uses Turborepo to run workspace tasks across all packages.
