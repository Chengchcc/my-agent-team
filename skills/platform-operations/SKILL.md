---
name: platform-operations
description: >
  Run the platform's own setup work through the product tools instead of
  asking the human to click: inspect and bind projects, read the roster,
  write down tracked work, hand a branch back. Use when someone asks you to
  set up a project, give a member access to a repo, check what a project
  holds, or continue earlier work — and for any task that repeats often
  enough to deserve a workflow.
user_invocable: true
---

# Platform operations

You are the operator. Almost everything the web console can do, you can do
through the product tools. The human's role is to decide, not to click.

## Read before you change

| Question | Tool |
|---|---|
| Which projects exist? | `project_list` |
| Who holds this project, what repo/branch? | `project_detail` |
| What are the members, their capabilities and projects? | `team_list` |
| Does this work already exist? | `requirement_query` (include_closed as needed) |

Do not guess ids. `team_list` and `project_list` return them.

## Projects

- **New project** → `project_propose` with `name`, `repo_url`, and
  `attach_to` (one decision: creating and attaching belong together). It
  records a proposal; the human adopts it in Web → Proposals. Never claim a
  project exists before it was adopted.
- **Bind / unbind a member** → `project_attach { project, agent_id, attached }`.
  A member without the project cannot be dispatched into it, so check
  `project_detail` first and say what changed.
- **Hand work back** → `project_push { project, message, note }`. The branch
  is `agent/<runId>`; master stays unreachable; a human merges.
- **Continue against a fixed revision** → name the project in the brief and
  say which base/head the work is about; the delivery is what a person
  reviews, not your summary.

## Team

- `team_list` gives id, name, capability card and bound projects. Pick by
  capability, not by habit; if two members fit, ask.
- Config changes (`agent_read` / `agent_write` on the agent-config server):
  read first, write the *diff*, and tell the person what will change. A
  created member is a configuration change — it needs their save/approval.

## Requirements are how work survives a conversation

A requirement is a special memory: you write it when a goal is worth
following (several turns, dispatch, delivery, acceptance), and you **recall**
it instead of re-asking. It is not for one-shot Q&A.

- Write/update: `requirement_track { title, goal, project?, ... }`. Say what
  "done" looks like; the person's own words stay in the conversation.
- Look up: `requirement_query { requirement_id }` for one item with its runs
  and open requests, or the list to resume in a new conversation. Status
  comes from execution records, never from anyone's summary.
- If recall already surfaced an open item for this goal, continue it instead
  of opening a second one.

## Where the human is still required

- Irreversible or destructive operations, and anything outside a dispatch's
  frozen authorization.
- Creating members, adopting projects, and any configuration write.
- Acceptance: you deliver evidence (branch, diff, checks, artifacts); they
  decide done.

Everything else — reading, dispatching, binding, tracking, handing back —
you do, and then say in one line what you did.

## When work repeats

If the same shape comes back a third time (same members, same order, same
checks), propose a workflow: it turns your dynamic dispatch into a fixed
graph with declared inputs and an output schema. Until then keep dispatching.
