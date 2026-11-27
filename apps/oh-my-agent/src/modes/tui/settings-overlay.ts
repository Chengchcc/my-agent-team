import {
  Container,
  Input,
  renderModalFrame,
  SelectList,
  type SelectListTheme,
  truncateToWidth,
  tuiTheme,
} from "@chengchenccc/tui";
import type { ProjectSettings } from "../../core/settings/project-settings.js";

type SettingKey = keyof ProjectSettings;

/** A row either edits a scalar or cycles an enum. The enum carries its own
 *  legal values, so the UI can never write one the settings parser will throw
 *  away — a `string` row would happily store a typo and show it back while the
 *  runtime kept using the default. */
type SettingRow =
  | { key: SettingKey; label: string; hint?: string; kind: "boolean" | "number" | "string" }
  | {
      key: SettingKey;
      label: string;
      hint?: string;
      kind: "enum";
      options: readonly string[];
    };

const THEME: SelectListTheme = {
  selectedPrefix: (s) => `${tuiTheme.accent}${s}\u001b[0m`,
  selectedText: (s) => `\u001b[1m${s}\u001b[0m`,
  selectedBg: (s) => `${tuiTheme.bgPanel}${s}\u001b[0m`,
  description: (s) => `${tuiTheme.dim}${s}\u001b[0m`,
  scrollInfo: (s) => `${tuiTheme.dim}${s}\u001b[0m`,
  noMatch: (s) => `${tuiTheme.dim}${s}\u001b[0m`,
};

/** Exported for the test that pins discoverability: a knob the runtime honors
 *  but /settings cannot reach is a knob nobody finds. */
export const SETTING_ROWS: SettingRow[] = [
  { key: "maxSteps", label: "maxSteps", hint: "Max agent tool turns per run", kind: "number" },
  {
    key: "modelTimeoutMs",
    label: "modelTimeoutMs",
    hint: "Model stream timeout in milliseconds",
    kind: "number",
  },
  {
    key: "mcpTimeoutMs",
    label: "mcpTimeoutMs",
    hint: "MCP tool call timeout in milliseconds",
    kind: "number",
  },
  {
    key: "askTimeoutMs",
    label: "askTimeoutMs",
    hint: "HITL ask auto-answer timeout in ms (0 = off)",
    kind: "number",
  },
  {
    key: "bashTimeoutMs",
    label: "bashTimeoutMs",
    hint: "Default bash command timeout in milliseconds",
    kind: "number",
  },
  {
    key: "maxToolTimeoutMs",
    label: "maxToolTimeoutMs",
    hint: "Upper bound on any tool timeout in ms",
    kind: "number",
  },
  {
    key: "bashSandbox",
    label: "bashSandbox",
    hint: "OS-level bash sandbox (bwrap / Seatbelt)",
    kind: "boolean",
  },
  {
    key: "browserLocalNetwork",
    label: "browserLocalNetwork",
    hint: "Allow localhost / LAN browser targets",
    kind: "boolean",
  },
  {
    key: "editFreshness",
    label: "editFreshness",
    hint: "require = edit/write must match a recent read fingerprint",
    kind: "string",
  },
  {
    key: "memoryExtract",
    label: "memoryExtract",
    hint: "Extract durable facts to .oma/memory after runs",
    kind: "boolean",
  },
  {
    key: "memoryModel",
    label: "memoryModel",
    hint: "Override model for background memory extraction",
    kind: "string",
  },
  {
    key: "memoryMinToolCalls",
    label: "memoryMinToolCalls",
    hint: "Minimum tool calls before memory extraction runs",
    kind: "number",
  },
  {
    key: "permissionClassifierModel",
    label: "permissionClassifierModel",
    hint: "Model used by permissionMode=auto classifier",
    kind: "string",
  },
  {
    key: "titleEnabled",
    label: "titleEnabled",
    hint: "Auto-generate concise session titles",
    kind: "boolean",
  },
  {
    key: "disableWeb",
    label: "disableWeb",
    hint: "Disable web_search / web_fetch",
    kind: "boolean",
  },
  {
    key: "enableClaude",
    label: "enableClaude",
    hint: "Load Claude Code compatibility artifacts",
    kind: "boolean",
  },
  {
    key: "enableCodex",
    label: "enableCodex",
    hint: "Load Codex compatibility artifacts",
    kind: "boolean",
  },
  {
    key: "enableAgents",
    label: "enableAgents",
    hint: "Enable subagent delegation (task / hub)",
    kind: "boolean",
  },
  {
    key: "planModel",
    label: "planModel",
    hint: "Dedicated model for /plan investigation turns",
    kind: "string",
  },
  // This is the only way into the build loop (a queue and a fresh session per
  // item), so it has to be visible here: nothing else names it.
  {
    key: "loopAction",
    label: "loopAction",
    hint: "Action between /loop iterations (ralph = build loop)",
    kind: "enum",
    options: ["prompt", "compact", "reset", "ralph"],
  },
];

function rowValue(settings: ProjectSettings, key: SettingKey): string {
  const v = settings[key];
  if (typeof v === "boolean") return v ? "on" : "off";
  if (v === undefined || v === null || v === "") return "(unset)";
  if (Array.isArray(v)) return v.length > 0 ? `${v.length} dirs` : "(none)";
  return String(v);
}

function styledValue(settings: ProjectSettings, row: SettingRow): string {
  const val = rowValue(settings, row.key);
  if (row.kind === "boolean") {
    return val === "on"
      ? `${tuiTheme.success}● on\u001b[0m`
      : val === "off"
        ? `${tuiTheme.dim}○ off\u001b[0m`
        : `${tuiTheme.dim}(unset)\u001b[0m`;
  }
  if (val === "(unset)") return `${tuiTheme.dim}(unset)\u001b[0m`;
  return `${tuiTheme.info}${val}\u001b[0m`;
}

/** Modal settings editor (omp SettingsSelector-container-inspired):
 *  a ModalFrame-wrapped SelectList of rows; Enter toggles booleans, cycles
 *  enums, or opens an inline text Input; cursor position is preserved across
 *  every edit; Esc saves and closes. */
export class SettingsOverlay extends Container {
  private readonly settings: ProjectSettings;
  private list!: SelectList;
  private readonly listSlot: Container = new Container();
  private editing: { row: SettingRow; input: Input } | null = null;

  constructor(
    settings: ProjectSettings,
    private readonly onDone: () => void,
  ) {
    super();
    this.settings = { ...settings };
    this.rebuild(0);
  }

  getSettings(): ProjectSettings {
    return this.settings;
  }

  private displayValue(key: SettingKey): string {
    return rowValue(this.settings, key);
  }

  private itemFor(row: SettingRow): { value: string; label: string; description: string } {
    return {
      value: row.key,
      label: row.label,
      description: `${styledValue(this.settings, row)} ${tuiTheme.dim}· ${row.kind}\u001b[0m`,
    };
  }

  private rebuild(preserveIndex?: number): void {
    const prevIndex = preserveIndex ?? this.list?.getSelectedIndex() ?? 0;
    this.list = new SelectList(
      SETTING_ROWS.map((row) => this.itemFor(row)),
      12,
      THEME,
      { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 28 },
    );
    this.list.setSelectedIndex(prevIndex);
    this.list.onSelect = (item) => {
      const row = SETTING_ROWS.find((r) => r.key === item.value);
      if (row) this.handleSelect(row);
    };
    this.list.onCancel = () => this.onDone();
    this.listSlot.clear();
    this.listSlot.addChild(this.list);
    this.invalidate();
  }

  private handleSelect(row: SettingRow): void {
    if (row.kind === "boolean") {
      const current = this.settings[row.key];
      const next = typeof current === "boolean" ? !current : true;
      Reflect.set(this.settings, row.key, next);
      this.rebuild();
      return;
    }
    if (row.kind === "enum") {
      // Cycle like a boolean toggles: no text to mistype, and the values are
      // enumerated in the row. Unset starts at the first option, which is the
      // documented default.
      const index = row.options.indexOf(String(this.settings[row.key] ?? ""));
      Reflect.set(this.settings, row.key, row.options[(index + 1) % row.options.length]);
      this.rebuild();
      return;
    }
    this.beginEdit(row);
  }

  private beginEdit(row: SettingRow): void {
    const input = new Input();
    input.setValue(this.displayValue(row.key) === "(unset)" ? "" : String(this.settings[row.key]));
    input.onSubmit = () => {
      this.commitEdit(row, input.getValue());
    };
    input.onEscape = () => {
      this.editing = null;
      this.invalidate();
    };
    this.editing = { row, input };
    this.invalidate();
  }

  private commitEdit(row: SettingRow, raw: string): void {
    let value: unknown = raw.trim();
    if (row.kind === "number") {
      if (raw.trim() === "") {
        value = undefined;
      } else {
        const parsed = Number(raw.trim());
        if (!Number.isFinite(parsed)) {
          this.editing = null;
          this.invalidate();
          return;
        }
        value = parsed;
      }
    } else if (value === "") {
      value = undefined;
    }
    Reflect.set(this.settings, row.key, value);
    this.editing = null;
    this.rebuild();
  }

  handleInput(data: string): void {
    if (this.editing) {
      this.editing.input.handleInput(data);
      return;
    }
    this.list.handleInput(data);
  }

  override render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const lines: string[] = [];
    if (this.editing) {
      lines.push(
        `${tuiTheme.accent}Edit ${this.editing.row.label}\u001b[0m ${tuiTheme.dim}(${this.editing.row.kind})\u001b[0m`,
      );
      lines.push(...this.editing.input.render(innerWidth));
      lines.push("---");
    }
    lines.push(...this.list.render(innerWidth));
    const selected = this.list.getSelectedItem();
    const activeRow = selected ? SETTING_ROWS.find((r) => r.key === selected.value) : undefined;
    if (activeRow?.hint) {
      lines.push("---");
      const extra = activeRow.kind === "enum" ? ` [${activeRow.options.join(" | ")}]` : "";
      lines.push(
        `${tuiTheme.dim}${truncateToWidth(`${activeRow.hint}${extra}`, innerWidth)}\u001b[0m`,
      );
    }
    return renderModalFrame({
      title: "Project Settings",
      titleRight: `${this.list.getSelectedIndex() + 1}/${SETTING_ROWS.length}`,
      footer: this.editing
        ? "Enter save · Esc cancel edit"
        : "Enter edit/toggle · ↑/↓ move · PgUp/PgDn scroll · Esc close",
      lines,
      width,
    });
  }
}
