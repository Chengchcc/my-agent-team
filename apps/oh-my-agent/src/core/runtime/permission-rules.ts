import { dirname, relative, resolve } from "node:path";

export interface ParsedPermissionRule {
  readonly raw: string;
  readonly toolPattern: string;
  readonly targetPattern?: string;
}

const MULTI_WORD_CLIS = new Set([
  "git",
  "bun",
  "npm",
  "pnpm",
  "yarn",
  "cargo",
  "go",
  "docker",
  "kubectl",
  "gh",
  "uv",
  "make",
  "turbo",
  "python",
  "python3",
  "pytest",
  "node",
  "npx",
  "bunx",
]);

/** Parse a permission rule in either `tool:pattern`, `Tool(pattern)`, or bare `tool` form. */
export function parsePermissionRule(raw: string): ParsedPermissionRule | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const paren = trimmed.match(/^([A-Za-z0-9_*-]+)\(([\s\S]+)\)$/);
  if (paren) {
    const toolPattern = paren[1]!.toLowerCase();
    const targetPattern = paren[2]!.trim();
    return targetPattern
      ? { raw: trimmed, toolPattern, targetPattern }
      : { raw: trimmed, toolPattern };
  }
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    const toolPattern = trimmed.slice(0, colonIdx).trim();
    const targetPattern = trimmed.slice(colonIdx + 1).trim();
    if (!toolPattern) return null;
    return targetPattern
      ? { raw: trimmed, toolPattern, targetPattern }
      : { raw: trimmed, toolPattern };
  }
  return { raw: trimmed, toolPattern: trimmed };
}

/** Convert a simple glob (`*` = any chars, `?` = single char) to an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") out += "[\\s\\S]*";
    else if (ch === "?") out += "[\\s\\S]";
    else if ("\\^$.|+()[]{}".includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  out += "$";
  return new RegExp(out);
}

/** True when a shell command contains chaining, piping, redirection, newlines,
 *  or command substitution outside single quotes. Used to ensure a simple prefix
 *  allow rule like `bash:bun test*` can never authorize `bun test && curl ...`. */
export function hasShellCompoundSyntax(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\" && !inSingle && i + 1 < command.length) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle) continue;
    // Command substitution works inside double quotes too.
    if (ch === "`") return true;
    if (ch === "$" && command[i + 1] === "(") return true;
    if (inDouble) continue;
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r") return true;
    if (ch === ">" || ch === "<") return true;
  }
  return false;
}

function normalizePathTarget(rawPath: string, workspaceRoot?: string): string {
  const cleaned = rawPath.trim();
  if (!cleaned) return "";
  if (workspaceRoot) {
    const absRoot = resolve(workspaceRoot);
    const absTarget = resolve(absRoot, cleaned);
    const rel = relative(absRoot, absTarget).replaceAll("\\", "/");
    if (!rel.startsWith("..") && rel !== "") return rel;
  }
  return cleaned.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Extract the primary matchable target string from a tool's input arguments. */
export function extractPermissionTarget(
  toolName: string,
  input: unknown,
  workspaceRoot?: string,
): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  if (toolName === "bash" && typeof rec.command === "string") {
    const cmd = rec.command.trim();
    return cmd.length > 0 ? cmd : undefined;
  }
  if ((toolName === "edit" || toolName === "write") && typeof rec.path === "string") {
    const rel = normalizePathTarget(rec.path, workspaceRoot);
    return rel.length > 0 ? rel : undefined;
  }
  if (toolName === "browser" && typeof rec.url === "string") {
    const url = rec.url.trim();
    return url.length > 0 ? url : undefined;
  }
  if (toolName === "eval" && typeof rec.code === "string") {
    const first = rec.code.trim().split("\n")[0]?.trim() ?? "";
    return first.length > 0 ? first : undefined;
  }
  return undefined;
}

/** Match one permission rule against a tool call.
 *  For `mode === "allow"`, bash target-pattern rules refuse commands containing
 *  shell chaining/substitution syntax unless the rule itself includes it. */
export function matchesPermissionRule(
  rawRule: string,
  toolName: string,
  input: unknown,
  opts: { workspaceRoot?: string; mode: "allow" | "deny" },
): boolean {
  const rule = parsePermissionRule(rawRule);
  if (!rule) return false;
  if (!globToRegExp(rule.toolPattern).test(toolName)) return false;
  if (!rule.targetPattern || rule.targetPattern === "*") return true;
  const target = extractPermissionTarget(toolName, input, opts.workspaceRoot);
  if (!target) return false;
  if (
    opts.mode === "allow" &&
    toolName === "bash" &&
    hasShellCompoundSyntax(target) &&
    !hasShellCompoundSyntax(rule.targetPattern)
  ) {
    return false;
  }
  return globToRegExp(rule.targetPattern).test(target);
}

/** Return the first matching rule string from `rules`, or undefined. */
export function findMatchingPermissionRule(
  rules: Iterable<string>,
  toolName: string,
  input: unknown,
  opts: { workspaceRoot?: string; mode: "allow" | "deny" },
): string | undefined {
  for (const rule of rules) {
    if (matchesPermissionRule(rule, toolName, input, opts)) return rule;
  }
  return undefined;
}

/** Suggest a safe, scoped persistent permission rule for the TUI approval panel.
 *  Returns undefined when no safe scoped pattern can be derived (e.g. compound
 *  bash commands with pipes/chains). */
export function suggestPermissionRule(
  toolName: string,
  input: unknown,
  workspaceRoot?: string,
): string | undefined {
  if (toolName === "bash") {
    const cmd = extractPermissionTarget(toolName, input, workspaceRoot);
    if (!cmd || hasShellCompoundSyntax(cmd)) return undefined;
    const tokens = cmd.split(/\s+/).filter(Boolean);
    const t0 = tokens[0];
    if (!t0 || !/^[A-Za-z0-9._/@-]+$/.test(t0)) return undefined;
    if (MULTI_WORD_CLIS.has(t0)) {
      const t1 = tokens[1];
      if (t1 && !t1.startsWith("-") && /^[A-Za-z0-9._:@-]+$/.test(t1)) {
        const t2 = tokens[2];
        if (t1 === "run" && t2 && !t2.startsWith("-") && /^[A-Za-z0-9._:@-]+$/.test(t2)) {
          return `bash:${t0} ${t1} ${t2}*`;
        }
        return `bash:${t0} ${t1}*`;
      }
    }
    return `bash:${t0}*`;
  }
  if (toolName === "edit" || toolName === "write") {
    const rel = extractPermissionTarget(toolName, input, workspaceRoot);
    if (!rel) return undefined;
    const parent = dirname(rel);
    if (parent && parent !== ".") return `${toolName}:${parent}/*`;
    return `${toolName}:${rel}`;
  }
  if (toolName.startsWith("mcp__")) {
    return toolName;
  }
  return undefined;
}
