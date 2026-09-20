import { deleteSession, sessionDirFor } from "../../core/session/session-file.js";

/** Session-picker decisions shared by the terminal io. Free functions over an
 *  explicit `tui` handle (no closure over the io's state) so they can be
 *  reused by other drivers — and so tui-io.ts stays about wiring.
 *
 *  The ask_question panel used to live here as a pair of SelectList overlays
 *  (pickOne/pickNotice); it is now a docked panel (./ask-panel.ts), which is
 *  also why nothing here is a modal picker any more. */

/** One row of the resume picker: enough to find the session's FILE. */
export interface SessionPickRow {
  readonly id: string;
  readonly workspace?: string;
}

/** Delete the picked session's file. The picker owns the list bookkeeping
 *  (splice + setItems); this owns the decision, so the guards are testable
 *  without a terminal.
 *
 *  Two guards, both data-loss: the ACTIVE session's file must survive (the
 *  live append would recreate a bare file and the history would be gone), and
 *  a cross-workspace row (the "all" listing) must be deleted from ITS
 *  workspace dir — deleting from the current one would hit the wrong file or
 *  nothing at all. */
export function deletePickedSession(
  rows: readonly SessionPickRow[],
  id: string,
  currentSessionId?: string,
): { deleted: boolean; message?: string } {
  if (id === currentSessionId) {
    return { deleted: false, message: "cannot delete the session you are in — esc to close" };
  }
  const row = rows.find((r) => r.id === id);
  if (!row) return { deleted: false };
  const dir = row.workspace ? sessionDirFor(row.workspace) : undefined;
  if (!deleteSession(id, dir)) {
    return { deleted: false, message: `delete failed — ${id.slice(0, 8)}` };
  }
  return { deleted: true };
}
