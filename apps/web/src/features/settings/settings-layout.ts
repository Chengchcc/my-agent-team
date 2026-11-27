/** The shape of the Settings form: which fields sit in which section, in what
 *  order, and what a search matches. Pure; the page owns the active section. */

export type SettingsFieldId =
  | "language"
  | "password"
  | "providers"
  | "customKeys"
  | "reuseRoom"
  | "systemInfo";

export type SettingsSectionId = "workspace" | "models" | "execution" | "system";

export interface SettingsField {
  readonly id: SettingsFieldId;
  /** What the person knows it as; shown as the field's title. */
  readonly label: string;
  /** Other words a person may search by. */
  readonly words: readonly string[];
}

export interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly title: string;
  readonly description: string;
  readonly fields: readonly SettingsField[];
  /** Folded closed by default and left out of the section list. */
  readonly folded: boolean;
}

/** The sections in reading order. The nav lists the unfolded ones; the
 *  folded one follows them. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "workspace",
    title: "Workspace",
    description: "Set how you read the console and how you sign in to it.",
    folded: false,
    fields: [
      { id: "language", label: "Interface language", words: ["english", "chinese", "locale"] },
      { id: "password", label: "Login password", words: ["sign in", "console", "credential"] },
    ],
  },
  {
    id: "models",
    title: "Models & credentials",
    description:
      "Check which provider keys are set. Whether a provider answers is a separate fact, read on the member's own page.",
    folded: false,
    fields: [
      { id: "providers", label: "Provider keys", words: ["api key", "base url", "model"] },
      { id: "customKeys", label: "Custom provider keys", words: ["models.yml", "api key"] },
    ],
  },
  {
    id: "execution",
    title: "Execution & permissions",
    description:
      "How a dispatch opens a room, and how much of the “is this work?” decision is delegated.",
    folded: false,
    fields: [{ id: "reuseRoom", label: "Dispatch", words: ["worker", "room", "conversation"] }],
  },
  {
    id: "system",
    title: "System info",
    description: "What the backend reports about itself. Nothing here can be changed.",
    folded: true,
    fields: [
      { id: "systemInfo", label: "System info", words: ["environment", "paths", "data dir"] },
    ],
  },
];

/** The sections the nav lists, in order. */
export const NAV_SECTIONS: readonly SettingsSection[] = SETTINGS_SECTIONS.filter(
  (section) => !section.folded,
);

/** The fields a search matches: every word of it must be in the field's title,
 *  its search words or its translated title. An empty search matches all. */
export function settingsSearch(
  query: string,
  text: (label: string) => string,
): readonly SettingsFieldId[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  const hits: SettingsFieldId[] = [];
  for (const section of SETTINGS_SECTIONS) {
    for (const field of section.fields) {
      const haystack = `${field.label} ${field.words.join(" ")} ${text(field.label)}`.toLowerCase();
      const matches = words.every((word) => haystack.includes(word));
      if (matches) hits.push(field.id);
    }
  }
  return hits;
}
