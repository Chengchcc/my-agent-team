---
name: requirement_memory
description: >
  Track work as a requirement — a special memory you write when a goal is worth
  following and recall instead of re-asking. Use before dispatching multi-turn
  work, when resuming in a new conversation, or when you notice the same goal
  being restated.
roles: front
user_invocable: true
---

# Work items are memory

A requirement is how a goal outlives a conversation: several turns, dispatch to
members, delivery, acceptance. It is not for one-shot Q&A.

## Write

`requirement_track { title, goal, project?, background?, constraints?,
expected_deliverables?, acceptance_criteria? }`

- Create for a goal worth following; update with `requirement_id` and only the
  fields you are changing.
- `goal` says what "done" looks like in your words. The person's own words stay
  in the conversation — they are evidence, your summary is interpretation, and
  the person can correct you.
- Never open a second item for a goal that already exists.

## Recall

- `requirement_query { requirement_id }` — one item with its runs, their
  verification and any open requests.
- `requirement_query { include_closed: true }` — the list, to resume work or to
  check whether this is the same goal.
- Recall also surfaces open items from cues in a request; if one matches, you
  continue it instead of creating.

## Status comes from records

`waiting_user` means a request is owned by the human; `pending_acceptance`
means the newest attempt passed its checks and only a person's acceptance is
left. Do not restate status from anyone's summary, and do not mark an item done
on your own — a person closes it, and the closing keeps the runs as evidence.
