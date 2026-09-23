import { GATEWAY_USAGE, type GatewayCommand, isGatewayCommand } from "./gateway-commands.js";
import { UPDATE_USAGE } from "./update-command.js";

export type CliMode = "print" | "json" | "rpc" | "tui";

export type PermissionFlag = "ask" | "auto" | "deny" | "off" | "yolo";

export interface CliArgs {
  mode: CliMode;
  /** True when -p/--mode was given explicitly; a bare positional prompt
   *  keeps this false so main() can open the TUI with it prefilled. */
  modeExplicit: boolean;
  prompt: string;
  listModels: boolean;
  /** Canonical `<provider>/<model>` id; undefined = first available model. */
  model?: string;
  /** Resume a session file by id (all modes; TUI and one-shot). */
  session?: string;
  /** --continue: resume the workspace's most recent session. */
  continueLast?: boolean;
  /** Standalone permission gate; undefined = .oma/settings.json decides. */
  permission?: PermissionFlag;
  /** --read-only: run with no write/edit/bash/eval tools. */
  readOnly?: boolean;
  /** `oma gateway <command>`: the gateway domain (backend + web) verbs. */
  gateway?: GatewayCommand;
  /** `oma update [--check] [--version <v>]`: the release updater. */
  update?: boolean;
  /** `oma update --check`: report only. */
  updateCheck?: boolean;
  /** `oma update --version <v>`: pin the target version. */
  updateVersion?: string;
  /** `oma gateway up|fetch --version <v>`: pin the artifact version. */
  gatewayVersion?: string;
  /** `oma gateway up -d`: run detached. */
  gatewayDetach?: boolean;
  /** Tool filter: comma-separated tool names or groups. Plain names form a
   *  whitelist (ONLY those tools run); `!name` entries form a blacklist
   *  (all but those). Applied to the FINAL tool table (native + MCP +
   *  plugin) at Run assembly. */
  tools?: string;
}

export class UsageError extends Error {}

const USAGE = `oma - Oma coding agent

Usage:
  oma                            interactive TUI (default in a terminal)
  oma --session <id>             resume a session in the TUI
  oma -p "<prompt>"              print mode: one Run, final text on stdout
  oma "<prompt>"                 print mode shorthand
  oma --mode json "<prompt>"     json mode: all events + one outcome as JSONL
  oma --mode rpc                 rpc mode: stdin/stdout JSONL protocol
  oma --list-models              print the model catalog as JSON
  oma update                     update the CLI + gateway artifact to the
                                 newest published version
  oma update --check             report what is installed vs what is published
  oma gateway up                 start backend + web (foreground, Ctrl-C stops)
  oma gateway up -d              same, detached (returns once healthy)
  oma gateway down               stop a detached gateway
  oma gateway status             installed version, running state, health
  oma gateway fetch              download + verify the gateway artifact
  oma --continue                 resume the most recent session
  oma --session <id> -p "..."    one-shot follow-up on a session
  oma --permission ask -p "..."  gate bash/write/mcp behind approval cards
  oma --yolo -p "..."            ungated run (OS sandbox forced when present)
  oma --model <provider/model> -p "<prompt>"
                                          pick a model by canonical id
                                          (default: first available model)

Piped stdin (print/json modes):
  cat file | oma -p "Review"
  git diff | oma --mode json "Review"
  cat error.log | oma -p          (stdin only)
`;

const MODES = ["print", "json", "rpc", "tui"];
const PERMISSIONS = ["ask", "auto", "deny", "off", "yolo"];

/** Parse argv SYNTAX only: whether a run actually has an input (prompt or
 *  piped stdin) is decided in main() after stdin is read. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    mode: "print",
    modeExplicit: false,
    prompt: "",
    listModels: false,
  };
  const positional: string[] = [];
  let modeFlag: string | null = null;

  // `oma gateway <verb>` — a reserved first word, because the first positional
  // is otherwise the prompt (`oma "explain this"`). `oma -p "gateway up"` is the
  // escape hatch when the word really is part of a prompt.
  if (argv[0] === "gateway") return parseGatewayArgs(argv.slice(1), args);
  // Same reservation for `oma update` (the release updater): a bare `oma update`
  // must not become the prompt "update".
  if (argv[0] === "update") return parseUpdateArgs(argv.slice(1), args);

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "-p") {
      // `-p` means "one-shot with this prompt", NOT "force print mode": an
      // explicit --mode (either order) must win, or `--mode json -p x` would
      // silently run print mode and print bare text where JSONL was expected.
      modeFlag ??= "print";
      args.modeExplicit = true;
    } else if (arg === "--mode") {
      const value = argv[i + 1];
      if (!value || !MODES.includes(value)) {
        throw new UsageError(`--mode requires one of: ${MODES.join(" | ")}`);
      }
      modeFlag = value;
      args.modeExplicit = true;
      i++;
    } else if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (!MODES.includes(value)) {
        throw new UsageError(`--mode requires one of: ${MODES.join(" | ")}`);
      }
      modeFlag = value;
      args.modeExplicit = true;
    } else if (arg === "--list-models") {
      args.listModels = true;
    } else if (arg === "--model") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new UsageError("--model requires a canonical <provider>/<model> id");
      }
      args.model = value;
      i++;
    } else if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (!value) throw new UsageError("--model requires a canonical <provider>/<model> id");
      args.model = value;
    } else if (arg === "--session") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new UsageError("--session requires a session id");
      }
      args.session = value;
      i++;
    } else if (arg.startsWith("--session=")) {
      const value = arg.slice("--session=".length);
      if (!value) throw new UsageError("--session requires a session id");
      args.session = value;
    } else if (arg === "--continue" || arg === "-c") {
      args.continueLast = true;
    } else if (arg === "--read-only") {
      args.readOnly = true;
    } else if (arg === "--yolo") {
      // The industry's skip-permissions flag (crush --yolo / CC
      // --dangerously-skip-permissions): ungated run. Boundaries that do
      // not depend on judgment (workspace containment, protected files,
      // secret stripping, egress rules, write freshness) all remain.
      args.permission = "yolo";
    } else if (arg === "--permission") {
      const value = argv[i + 1];
      if (!value || !PERMISSIONS.includes(value)) {
        throw new UsageError(`--permission requires one of: ${PERMISSIONS.join(" | ")}`);
      }
      args.permission = value as PermissionFlag;
      i++;
    } else if (arg.startsWith("--permission=")) {
      const value = arg.slice("--permission=".length);
      if (!PERMISSIONS.includes(value)) {
        throw new UsageError(`--permission requires one of: ${PERMISSIONS.join(" | ")}`);
      }
      args.permission = value as PermissionFlag;
    } else if (arg === "--tools") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new UsageError("--tools requires a comma-separated tool list");
      }
      args.tools = value;
      i++;
    } else if (arg.startsWith("--tools=")) {
      const value = arg.slice("--tools=".length);
      if (!value) throw new UsageError("--tools requires a comma-separated tool list");
      args.tools = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new UsageError(USAGE);
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown option: ${arg}\n\n${USAGE}`);
    } else {
      positional.push(arg);
    }
    i++;
  }
  if (modeFlag) args.mode = modeFlag as CliMode;
  args.prompt = positional.join(" ");
  return args;
}

/** Parse `oma update [--check] [--version <v>]`. Like the gateway surface it
 *  takes no prompt, session or mode — the first position is a verb. */
function parseUpdateArgs(rest: readonly string[], args: CliArgs): CliArgs {
  const first = rest[0];
  if (first !== undefined && !first.startsWith("-")) {
    throw new UsageError(`oma update takes no argument: ${first}\n\n${UPDATE_USAGE}`);
  }
  args.update = true;
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i] ?? "";
    if (arg === "--check" || arg === "-c") {
      args.updateCheck = true;
      i += 1;
      continue;
    }
    if (arg === "--version") {
      const value = rest[i + 1];
      if (!value || value.startsWith("-")) {
        throw new UsageError("oma update --version needs a version like 0.2.0");
      }
      args.updateVersion = value;
      i += 2;
      continue;
    }
    if (arg.startsWith("--version=")) {
      const value = arg.slice("--version=".length);
      if (!value) throw new UsageError("oma update --version needs a version like 0.2.0");
      args.updateVersion = value;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") throw new UsageError(UPDATE_USAGE);
    throw new UsageError(`unknown update option: ${arg}\n\n${UPDATE_USAGE}`);
  }
  return args;
}

/** Parse `oma gateway <verb> [--version <v>]`. Kept separate from the main
 *  loop: the gateway surface takes no prompt, session or mode. */
function parseGatewayArgs(rest: readonly string[], args: CliArgs): CliArgs {
  const verb = rest[0];
  if (verb === undefined || verb.startsWith("-")) {
    throw new UsageError(`oma gateway needs a command\n\n${GATEWAY_USAGE}`);
  }
  if (!isGatewayCommand(verb)) {
    throw new UsageError(`unknown gateway command: ${verb}\n\n${GATEWAY_USAGE}`);
  }
  args.gateway = verb;

  let i = 1;
  while (i < rest.length) {
    const arg = rest[i] ?? "";
    if (arg === "--version") {
      const value = rest[i + 1];
      if (!value || value.startsWith("-")) {
        throw new UsageError("oma gateway --version needs a version like 0.2.0");
      }
      args.gatewayVersion = value;
      i += 2;
      continue;
    }
    if (arg.startsWith("--version=")) {
      const value = arg.slice("--version=".length);
      if (!value) throw new UsageError("oma gateway --version needs a version like 0.2.0");
      args.gatewayVersion = value;
      i += 1;
      continue;
    }
    if (arg === "--detach" || arg === "-d") {
      args.gatewayDetach = true;
      i += 1;
      continue;
    }
    throw new UsageError(`unknown gateway option: ${arg}\n\n${GATEWAY_USAGE}`);
  }
  return args;
}
