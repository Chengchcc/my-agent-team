---
name: reminder_manage
description: >
  Schedule, inspect, or cancel one-shot and recurring reminders in the current
  conversation using remind_me, reminder_list, and reminder_cancel. Use when the
  user asks to be reminded later, wants a periodic check-in or maintenance loop,
  or wants to view or stop scheduled reminders.
user_invocable: true
---

# Reminder management

Reminders fire back into the conversation where they were created and wake a run to act on or voice the reminder text.

## Tools

| Intent | Tool |
|---|---|
| Create one-shot or recurring reminder | `remind_me { text, fireAt, recurrence? }` |
| List your pending reminders | `reminder_list {}` |
| Cancel a pending reminder | `reminder_cancel { id }` |

## Parameters & rules

- **`fireAt`**: integer epoch milliseconds strictly in the future (`> Date.now()`). Required for both one-shot and recurring reminders (for recurring reminders, it marks the first fire time).
- **`recurrence`**: optional 5-field cron expression in **UTC** (e.g. `"0 1 * * 1"` for Mondays 09:00 UTC+8). Omit for one-shot reminders.
- **`text`**: must be self-contained. When the reminder fires in a future run, the woken agent may have minimal short-term context — include what to check, notify, or follow up on.

## Operating discipline

1. **Confirm timezone conversion.** Convert relative or local times ("in 30 minutes", "tomorrow 9am", "every Monday 09:00") accurately to UTC epoch ms / UTC cron. If the user's timezone is unknown and ambiguous for a wall-clock time, ask once before scheduling. Always report the scheduled timestamp (with timezone) and `id` back to the user.
2. **Check before duplicating.** Call `reminder_list` before creating a recurring reminder so you do not stack duplicate schedules for the same check-in.
3. **Modify = cancel + recreate.** Reminders are immutable once scheduled. To change time, cron, or text, list via `reminder_list`, cancel the old `id` with `reminder_cancel`, and schedule the new one with `remind_me`. Never guess a reminder `id`.
4. **Do not schedule recurring runs unprompted.** Every recurring trigger spends model budget — only create a recurring reminder when the user asks for it (or explicitly approves a proposed schedule).
5. **Pair with the right scope.** A reminder is for nudges, follow-ups, and lightweight periodic checks in this conversation. For multi-step automated pipelines with typed outputs, retries, or human approval forms, design a workflow (`workflow_design`) instead.
