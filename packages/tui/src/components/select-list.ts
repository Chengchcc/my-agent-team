import { getKeybindings } from "../keybindings.ts";
import { matchesKey } from "../keys.ts";
import { tuiTheme } from "../theme.ts";
import type { Component } from "../tui.ts";
import { applyBackgroundToLine, truncateToWidth, visibleWidth } from "../utils.ts";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();
const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, max));

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

export interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  /** Optional full-row background tint for the selected item. */
  selectedBg?: (line: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

export interface SelectListTruncatePrimaryContext {
  text: string;
  maxWidth: number;
  columnWidth: number;
  item: SelectItem;
  isSelected: boolean;
}

export interface SelectListLayoutOptions {
  minPrimaryColumnWidth?: number;
  maxPrimaryColumnWidth?: number;
  truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
  /** Custom empty-list placeholder (default: "  No matches"). */
  emptyMessage?: string;
  /** Show a 1-column right-edge scrollbar when list overflows maxVisible (default: true). */
  showScrollbar?: boolean;
}

export class SelectList implements Component {
  private items: SelectItem[] = [];
  private filteredItems: SelectItem[] = [];
  private selectedIndex: number = 0;
  private maxVisible: number = 5;
  private theme: SelectListTheme;
  private layout: SelectListLayoutOptions;

  public onSelect?: (item: SelectItem) => void;
  public onCancel?: () => void;
  public onSelectionChange?: (item: SelectItem) => void;
  /** Fired on the delete binding. The owner removes the item and calls
   *  setItems — the list does not mutate its collection behind its back. */
  public onDelete?: (item: SelectItem) => void;

  constructor(
    items: SelectItem[],
    maxVisible: number,
    theme: SelectListTheme,
    layout: SelectListLayoutOptions = {},
  ) {
    this.items = items;
    this.filteredItems = items;
    this.maxVisible = maxVisible;
    this.theme = theme;
    this.layout = layout;
  }

  /** Replace the collection (after a delete, a reload). Selection is clamped
   *  so it never points past the new end. */
  setItems(items: readonly SelectItem[]): void {
    this.items = [...items];
    this.filteredItems = this.items;
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.items.length - 1));
    this.notifySelectionChange();
  }

  setFilter(filter: string): void {
    const needle = filter.toLowerCase();
    this.filteredItems = this.items.filter(
      (item) =>
        item.value.toLowerCase().startsWith(needle) || item.label.toLowerCase().includes(needle),
    );
    this.selectedIndex = 0;
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  setSelectedIndex(index: number): void {
    if (this.filteredItems.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
  }

  invalidate(): void {
    // No cached state to invalidate currently
  }

  render(width: number): string[] {
    const lines: string[] = [];

    if (this.filteredItems.length === 0) {
      const emptyMsg = this.layout.emptyMessage ?? "  No matches";
      lines.push(this.theme.noMatch(truncateToWidth(emptyMsg, Math.max(1, width), "…")));
      return lines;
    }

    const primaryColumnWidth = this.getPrimaryColumnWidth();
    const total = this.filteredItems.length;
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), total - this.maxVisible),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, total);
    const visibleCount = endIndex - startIndex;
    const hasScroll = startIndex > 0 || endIndex < total;
    const drawScrollbar = hasScroll && this.layout.showScrollbar !== false && width >= 12;
    const rowWidth = drawScrollbar ? width - 2 : width;

    // Scrollbar thumb geometry (1-col right rail: ┃ thumb on │ track).
    const thumbSize = drawScrollbar
      ? Math.max(1, Math.round((visibleCount / total) * visibleCount))
      : 0;
    const maxStart = Math.max(1, total - visibleCount);
    const thumbStart = drawScrollbar
      ? Math.min(
          visibleCount - thumbSize,
          Math.round((startIndex / maxStart) * (visibleCount - thumbSize)),
        )
      : 0;

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i];
      if (!item) continue;

      const isSelected = i === this.selectedIndex;
      const descriptionSingleLine = item.description
        ? normalizeToSingleLine(item.description)
        : undefined;
      let row = this.renderItem(
        item,
        isSelected,
        rowWidth,
        descriptionSingleLine,
        primaryColumnWidth,
      );
      if (isSelected && this.theme.selectedBg) {
        row = applyBackgroundToLine(row, rowWidth, this.theme.selectedBg);
      }
      if (drawScrollbar) {
        const rel = i - startIndex;
        const padNeeded = Math.max(0, rowWidth - visibleWidth(row));
        const glyph =
          rel >= thumbStart && rel < thumbStart + thumbSize
            ? `${tuiTheme.accent}┃\x1b[0m`
            : `${tuiTheme.faint}│\x1b[0m`;
        row = `${row}${" ".repeat(padNeeded)} ${glyph}`;
      }
      lines.push(row);
    }

    if (hasScroll) {
      const scrollText = `  (${this.selectedIndex + 1}/${total})`;
      lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, Math.max(1, width - 2), "…")));
    }

    return lines;
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    const total = this.filteredItems.length;
    if (kb.matches(keyData, "tui.select.up")) {
      if (total === 0) return;
      this.selectedIndex = this.selectedIndex === 0 ? total - 1 : this.selectedIndex - 1;
      this.notifySelectionChange();
    } else if (kb.matches(keyData, "tui.select.down")) {
      if (total === 0) return;
      this.selectedIndex = this.selectedIndex === total - 1 ? 0 : this.selectedIndex + 1;
      this.notifySelectionChange();
    } else if (kb.matches(keyData, "tui.select.pageUp")) {
      if (total === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - Math.max(1, this.maxVisible - 1));
      this.notifySelectionChange();
    } else if (kb.matches(keyData, "tui.select.pageDown")) {
      if (total === 0) return;
      this.selectedIndex = Math.min(
        total - 1,
        this.selectedIndex + Math.max(1, this.maxVisible - 1),
      );
      this.notifySelectionChange();
    } else if (matchesKey(keyData, "home")) {
      if (total === 0) return;
      this.selectedIndex = 0;
      this.notifySelectionChange();
    } else if (matchesKey(keyData, "end")) {
      if (total === 0) return;
      this.selectedIndex = total - 1;
      this.notifySelectionChange();
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      const selectedItem = this.filteredItems[this.selectedIndex];
      if (selectedItem && this.onSelect) {
        this.onSelect(selectedItem);
      }
    } else if (kb.matches(keyData, "tui.select.delete")) {
      const selectedItem = this.filteredItems[this.selectedIndex];
      if (selectedItem && this.onDelete) {
        this.onDelete(selectedItem);
      }
    } else if (kb.matches(keyData, "tui.select.cancel")) {
      if (this.onCancel) {
        this.onCancel();
      }
    }
  }

  private renderItem(
    item: SelectItem,
    isSelected: boolean,
    width: number,
    descriptionSingleLine: string | undefined,
    primaryColumnWidth: number,
  ): string {
    const rawPrefix = isSelected ? "▸ " : "  ";
    const prefix = isSelected ? this.theme.selectedPrefix(rawPrefix) : rawPrefix;
    const prefixWidth = 2;

    if (descriptionSingleLine && width > 36) {
      const effectivePrimaryColumnWidth = Math.max(
        1,
        Math.min(primaryColumnWidth, width - prefixWidth - 4),
      );
      const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
      const truncatedValue = this.truncatePrimary(
        item,
        isSelected,
        maxPrimaryWidth,
        effectivePrimaryColumnWidth,
      );
      const truncatedValueWidth = visibleWidth(truncatedValue);
      const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
      const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
      const remainingWidth = width - descriptionStart - 1;

      if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
        const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "…");
        if (isSelected) {
          return `${prefix}${this.theme.selectedText(truncatedValue)}${spacing}${this.theme.description(truncatedDesc)}`;
        }
        return `${prefix}${truncatedValue}${this.theme.description(spacing + truncatedDesc)}`;
      }
    }

    const maxWidth = Math.max(1, width - prefixWidth - 1);
    const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
    if (isSelected) {
      return `${prefix}${this.theme.selectedText(truncatedValue)}`;
    }
    return `${prefix}${truncatedValue}`;
  }

  private getPrimaryColumnWidth(): number {
    const { min, max } = this.getPrimaryColumnBounds();
    const widestPrimary = this.filteredItems.reduce((widest, item) => {
      return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
    }, 0);

    return clamp(widestPrimary, min, max);
  }

  private getPrimaryColumnBounds(): { min: number; max: number } {
    const rawMin =
      this.layout.minPrimaryColumnWidth ??
      this.layout.maxPrimaryColumnWidth ??
      DEFAULT_PRIMARY_COLUMN_WIDTH;
    const rawMax =
      this.layout.maxPrimaryColumnWidth ??
      this.layout.minPrimaryColumnWidth ??
      DEFAULT_PRIMARY_COLUMN_WIDTH;

    return {
      min: Math.max(1, Math.min(rawMin, rawMax)),
      max: Math.max(1, Math.max(rawMin, rawMax)),
    };
  }

  private truncatePrimary(
    item: SelectItem,
    isSelected: boolean,
    maxWidth: number,
    columnWidth: number,
  ): string {
    const displayValue = this.getDisplayValue(item);
    const truncatedValue = this.layout.truncatePrimary
      ? this.layout.truncatePrimary({
          text: displayValue,
          maxWidth,
          columnWidth,
          item,
          isSelected,
        })
      : truncateToWidth(displayValue, maxWidth, "…");

    return truncateToWidth(truncatedValue, maxWidth, "…");
  }

  private getDisplayValue(item: SelectItem): string {
    return item.label || item.value;
  }

  private notifySelectionChange(): void {
    const selectedItem = this.filteredItems[this.selectedIndex];
    if (selectedItem && this.onSelectionChange) {
      this.onSelectionChange(selectedItem);
    }
  }

  getSelectedItem(): SelectItem | null {
    const item = this.filteredItems[this.selectedIndex];
    return item || null;
  }
}
