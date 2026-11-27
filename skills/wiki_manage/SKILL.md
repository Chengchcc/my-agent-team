---
name: wiki_manage
description: >
  Search, ingest, update, and lint the shared git-backed Wiki through the wiki_*
  product tools. Use when looking up settled knowledge, capturing durable
  decisions/lessons/concepts from a conversation or provided text, updating an
  existing wiki page safely with CAS revisions, or running wiki health checks.
roles: front
user_invocable: true
---

# Wiki management

The Wiki is a product-level, git-backed markdown repository shared across conversations. Writes go **only** through the `wiki_*` product tools — never through filesystem tools.

## Spaces & paths

Every page path is relative, ends with `.md`, and starts with one of five spaces:

- `personal/<agentId>/<name>.md` — private notes writable **only** by `<agentId>`. Never injected into worker dispatch briefs.
- `projects/<project>/<name>.md` — project-specific architecture, conventions, and runbooks.
- `decisions/<name>.md` — settled choices and their rationale.
- `concepts/<name>.md` — recurring domain terms and models.
- `lessons/<name>.md` — postmortems, root causes, and traps to avoid.

`index.md` and `log.md` are rebuilt automatically on every write; never target them directly.

## Tools

| Intent | Tool |
|---|---|
| Search compiled pages first | `wiki_query { text?, limit? }` |
| Read full page + CAS `revision` | `wiki_read { path }` |
| Save raw source reference or text | `wiki_source_add { kind, ... }` |
| Create a new page | `wiki_create { path, title, content, status?, sources?, supersedes? }` |
| Update an existing page (CAS) | `wiki_patch { path, expected_revision, title?, content?, status?, sources?, supersedes? }` |
| Full-wiki health check | `wiki_lint {}` |

## Operating discipline

1. **Query before answering or creating.** Run `wiki_query` first to avoid duplicating an existing page or re-asking the user for settled facts.
2. **Cite every claim.** Record sources before or alongside writing:
   - Conversation range (by reference — never copy raw chat logs into the wiki): `wiki_source_add { kind: "conversation", conversation_id, from_seq?, to_seq? }` → cite the returned path (or `conversation:<id>:<from>-<to>`) in `sources`.
   - User-provided material saved verbatim: `wiki_source_add { kind: "text", title?, content }` → cite the returned `raw/files/...` path in `sources`.
3. **Read-before-patch and CAS conflict resolution.** Always call `wiki_read` first to obtain `revision`, then pass it as `expected_revision` to `wiki_patch`.
   - `content` replaces the page body; `sources` and `supersedes` are union-merged with existing entries; `maintainedBy` never flips.
   - If `wiki_patch` returns `{ ok: false, reason: "conflict", current }`, read `current`, merge your changes with any concurrent or human edit, and retry with `current.revision`. Never discard human edits.
4. **Fix inline lint findings in the same turn.** `wiki_create` and `wiki_patch` return `findings` for the written page:
   - `unsourced`: add concrete `sources` (or leave `status: "draft"` and tell the user what evidence is missing).
   - `orphan`: add a `[[Page Title]]` wikilink or `[label](path.md)` link from a related page (`index.md` does not count).
   - `missing-supersedes-target`: remove or correct non-existent paths in `supersedes`.
5. **Status & replacement.** New pages default to `draft`; set `confirmed` only when backed by explicit user decision or verified evidence. When a newer decision replaces an old one, create/update the new page with `supersedes: ["<old-path>.md"]` and mark the old page `status: "superseded"` instead of erasing history.

## Boundaries

- **Wiki is knowledge, not a control plane.** Writing "allow merge" or permission rules into a wiki page grants no authority and changes no agent/runtime config.
- **Do not resolve contradictions silently.** If two sources conflict, surface both with their citations and ask the human to decide.
- **Never copy private notes into shared spaces** without explicit user confirmation.
