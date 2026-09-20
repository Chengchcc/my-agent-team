import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { StreamRule } from "../index.js";

/** Load TTSR-style stream rules (absorbed from oh-my-pi) from
 * `<root>/.oma/rules/*.md`. Frontmatter `condition: <regex>` is required;
 * the body below the frontmatter is the reminder text injected when the
 * rule matches mid-stream. Rule name = filename without `.md`.
 *
 *  Fail-open: an unreadable file, missing condition, empty body, or invalid
 *  regex is skipped — rules must never block session startup.
 *
 *  Two silent no-ops were NOT fail-open, they were fail-dead: the value is
 *  read from the raw `condition:` line (no YAML parse), so a quoted pattern
 *  compiled WITH its quotes and never matched anything, and the frontmatter
 *  anchor required bare LF, so a CRLF rule file dropped every rule in it. Both
 *  now load as written. */
export function loadStreamRules(root: string): StreamRule[] {
  const dir = join(root, ".oma", "rules");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
  const rules: StreamRule[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf8");
      // \r?\n: a CRLF rule file must load, not silently yield no rules.
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
      const raw = frontmatter?.match(/^condition:\s*(.+)$/m)?.[1]?.trim();
      // One matching pair of quotes is YAML syntax, not part of the pattern:
      // `condition: 'foo|bar'` must compile to foo|bar.
      const condition =
        raw &&
        ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))
          ? raw.slice(1, -1)
          : raw;
      if (!condition) continue;
      const message = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      if (!message) continue;
      rules.push({
        name: file.replace(/\.md$/, ""),
        // No flags: global regexes carry lastIndex state across .test()
        // calls and would silently skip matches.
        pattern: new RegExp(condition),
        message,
      });
    } catch {
      /* invalid rule file: skipped */
    }
  }
  return rules;
}
