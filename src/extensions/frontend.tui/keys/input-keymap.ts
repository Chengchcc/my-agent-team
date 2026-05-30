/** Editor-level key bindings. Populated by InputBox component at runtime. */
export interface InputBinding {
  id: string;
  label: string;
  description: string;
  match: (ev: { key: string; ctrl: boolean; meta: boolean; shift: boolean }) => boolean;
  handler: () => void;
}

export const INPUT_BINDINGS: InputBinding[] = [];
