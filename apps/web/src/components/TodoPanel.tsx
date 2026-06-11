"use client";

/** M14.6: Renders the task todo list pinned above the conversation timeline.
 *  Receives a full snapshot of todos from the durable todo_update event stream.
 *  Empty list → renders nothing (zero visual tax for trivial tasks). */
export function TodoPanel({
  todos,
}: {
  todos: Array<{ step: string; status: "pending" | "in_progress" | "done" }>;
}) {
  if (todos.length === 0) return null;

  const done = todos.filter((t) => t.status === "done").length;

  return (
    <div className="shrink-0 px-6 py-2 border-b border-[var(--hairline)] bg-[var(--canvas-soft)]">
      <p className="text-[10px] tracking-[0.1em] uppercase text-[var(--mute)] font-semibold mb-1">
        Plan &middot; {done}/{todos.length}
      </p>
      <ul className="space-y-0.5">
        {todos.map((t) => (
          <li key={t.step} className="flex items-center gap-2 text-xs">
            <span className="shrink-0 w-4 text-center">
              {t.status === "done"
                ? "☑"
                : t.status === "in_progress"
                  ? "▸"
                  : "☐"}
            </span>
            <span
              className={
                t.status === "done"
                  ? "line-through text-[var(--mute)]"
                  : t.status === "in_progress"
                    ? "text-[var(--primary)]"
                    : "text-[var(--body)]"
              }
            >
              {t.step}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
