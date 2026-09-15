import { SelectList, Text, type TUI } from "@chengchenccc/tui";
import { deleteSession, sessionDirFor } from "../../core/session/session-file.js";
import { PickerOverlay } from "./tui-components.js";
import { EDITOR_THEME } from "./tui-format.js";

/** One-shot modal pickers shared by the terminal io. Free functions over an
 *  explicit `tui` handle (no closure over the io's state) so they can be
 *  reused by other drivers — and so tui-io.ts stays about wiring. */

export function pickOne(
  tui: TUI,
  title: string,
  items: ReadonlyArray<{ value: string; label: string; description?: string }>,
): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const list = new SelectList([...items], 10, EDITOR_THEME.selectList, {
    minPrimaryColumnWidth: 6,
    maxPrimaryColumnWidth: 42,
  });
  const overlayBox = new PickerOverlay(new Text(title, 0, 0), list);
  const overlay = tui.showOverlay(overlayBox, { width: "70%", anchor: "center" });
  list.onSelect = (item: { value: string }) => {
    overlay.hide();
    resolve(item.value);
  };
  list.onCancel = () => {
    overlay.hide();
    resolve(null);
  };
  return promise;
}

/** Notice-only overlay; resolves true when dismissed, null is not needed. */
export function pickNotice(tui: TUI, title: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const list = new SelectList([{ value: "ok", label: "ok" }], 1, EDITOR_THEME.selectList, {
    minPrimaryColumnWidth: 2,
    maxPrimaryColumnWidth: 4,
  });
  const overlayBox = new PickerOverlay(new Text(title, 0, 0), list);
  const overlay = tui.showOverlay(overlayBox, { width: "60%", anchor: "center" });
  list.onSelect = () => {
    overlay.hide();
    resolve(true);
  };
  list.onCancel = () => {
    overlay.hide();
    resolve(true);
  };
  return promise;
}

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
