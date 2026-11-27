---
name: project_manage
description: >
  Read, create-toward, bind and hand back projects through the product tools.
  Use when someone asks what a project holds, to give a member access to a
  repo, to start a project the team does not have yet, or to deliver a branch.
roles: front
user_invocable: true
---

# Project management

You operate the project registry; the human decides what gets adopted.

## Read first

- `project_list` — id, name, repo.
- `project_detail { project }` — the same project plus **who holds it** and its
  default branch. Attaching or dispatching without this is guessing.
- `team_list` — members with their capability cards and bound projects.

Ids come from these tools; never invent one.

## Calls

| Intent | Tool |
|---|---|
| New project (needs a human's adoption) | `project_propose { name, repo_url, attach_to }` |
| Change a registered project (needs the human's save) | `project_propose { project_id, name?, repo_url?, default_branch? }` |
| Bind / unbind a member | `project_attach { project, agent_id, attached }` |
| Hand a branch back | `project_push { project, message, note }` |

- `project_propose` never creates: it files a proposal, and adopting it in
  Web → Proposals is what creates the project and attaches `attach_to` in one
  decision. Say "proposed", never "created", until it is adopted.
- With `project_id` the same tool files a **change** to a registered project.
  The human reviews it beside the project's form, and their save is what applies
  it. Say "proposed", never "changed", until it is adopted. Name only the fields
  the request is about; the rest stay as they are.
- `project_attach` changes team configuration, so it needs the human's
  approval. After it, say which member now holds the project.
- `project_push` commits the worktree and pushes `agent/<runId>`; master stays
  unreachable and a person merges. Not for saving partial state.

## Delivery is evidence, not a claim

Name the project and the revision in your delivery line, and point at what was
produced (branch, diff, artifacts, checks). A person decides merge/acceptance;
that decision is not yours to take.
