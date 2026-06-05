# Bun + Turborepo Monorepo Design

## Goal

Initialize a clean monorepo managed by Bun workspaces and Turborepo. The repository should provide shared tooling, a package template, and an interactive CLI for creating new empty TypeScript packages under `apps/**` or `packages/**`.

## Repository Structure

```txt
apps/
packages/
_template/
  package/
scripts/
  create-package.ts
docs/superpowers/specs/
```

The root owns shared configuration, scripts, CI, and documentation. `apps/**` and `packages/**` are Bun workspace locations. `_template/package` is only a source template for the generator and is not included as a workspace package.

## Tooling

The repository uses:

- Bun for package management and script execution.
- Turborepo for orchestrating `lint`, `typecheck`, `test`, and `build` across workspaces.
- TypeScript for shared type checking and Node/Bun library output.
- Biome for formatting and base linting.
- ESLint for TypeScript lint rules that complement Biome.
- GitHub Actions for CI.

Root scripts should include at least:

- `lint`
- `format`
- `typecheck`
- `test`
- `build`
- `create`

CI should run `bun install --frozen-lockfile`, then the same lint, typecheck, test, and build commands used locally.

## Package Template

`_template/package` defines a Node/Bun TypeScript library package. It contains:

- `package.json`
- `tsconfig.json`
- `src/index.ts`

The template uses placeholders such as `{{name}}` and `{{description}}`. Generated packages are ESM packages that build with `tsc`, emit declarations, expose `dist/index.js`, and include `exports`, `types`, and `files` metadata.

Each generated package provides standard scripts so Turborepo can discover package-level work:

- `lint`
- `typecheck`
- `test`
- `build`

## Package Creation CLI

`scripts/create-package.ts` is an interactive CLI run with Bun. It prompts for:

1. Target area: `apps` or `packages`
2. Directory name
3. Package name
4. Description

The script checks that the target path does not already exist, copies `_template/package`, replaces placeholders, and prints the next useful commands.

## Documentation

The root README explains:

- Workspace layout
- Common commands
- How to create a new package
- Lint, typecheck, test, and build expectations

## Validation

Implementation is complete when these checks pass:

- `bun install`
- `bun run lint`
- `bun run typecheck`
- `bun run build`
- The create CLI can generate a temporary package from `_template/package`
- The generated package has placeholders replaced correctly
- Turbo can run tasks with the generated package present
- The temporary package is removed before final handoff

## Git Handling

If the target directory is not already a git repository, initialize git before committing the design document and implementation changes.
