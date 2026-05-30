export interface PickerBinding {
  id: string;
  label: string;
  description: string;
  key: string;
  scope: 'slash-picker' | 'file-picker';
}

export const PICKER_BINDINGS: ReadonlyArray<PickerBinding> = [
  { id: 'picker-up', label: '↑↓', description: 'Navigate items', key: 'up/down', scope: 'slash-picker' },
  { id: 'picker-enter', label: 'Enter', description: 'Select item', key: 'enter', scope: 'slash-picker' },
  { id: 'picker-esc', label: 'Esc', description: 'Close picker', key: 'escape', scope: 'slash-picker' },
];
