export const PRIORITY = {
  /** Cheatsheet overlay, full-screen modals */
  MODAL: 100,
  /** Slash command picker, file picker, session picker */
  PICKER: 80,
  /** Editor keys: ctrl+a/e/w, tab completion, arrow keys */
  INPUT_EDIT: 40,
  /** Global chrome: ctrl+t/d/o, esc-abort, ctrl+k, ctrl+c, ? */
  GLOBAL_CHROME: 20,
  /** Text insertion fallback — always last */
  FALLTHROUGH: 0,
} as const;
