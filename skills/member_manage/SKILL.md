---
name: member_manage
description: >
  Read the roster and change a member's configuration through the product and
  agent-config tools. Use when someone asks who is on the team, which member
  fits a job, to add a member, or to change a member's model, role, projects or
  allowed paths.
roles: front
user_invocable: true
---

# Member management

## Read

- `team_list` — id, name, description, skills, and **the projects each member
  holds**. Pick by capability, not by habit; two fitting members is a question.
- `agent_read` (agent-config server) — one member's full config before you
  change anything.

## Change

- `agent_write` (agent-config server) — write the *diff* you intend, not the
  whole config, and say in one line what will change for whom.
- Creating a member or changing its config is a configuration change: it needs
  the human's save/approval. `agent_create` exists, but never treat a created
  member as live until that approval happened.
- A member only works in a project's copies when it holds the project:
  `project_attach { project, agent_id }` (see `project_manage`).

## Roles, in one line each

- **front** routes and holds: it answers, dispatches, and escalates to the
  human. It does not take a project checkout.
- **worker** produces: it works in a requirement's checkout for a project it
  holds, and hands back a branch.

Putting a worker in a project it does not hold, or expecting a front desk to
produce a diff, are both configuration mistakes — say so instead of retrying.
