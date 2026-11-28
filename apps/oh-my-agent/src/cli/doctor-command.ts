import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelRuntime } from "@chengchenccc/ai";
import { isFileTrusted, readTrustedPlugins } from "../core/plugins/plugin-trust.js";
import { loadRuntimeCatalog } from "../core/runtime/runtime-catalog.js";
import { loadProjectSettings } from "../core/settings/project-settings.js";
import { resolveBashSandbox } from "../core/tools/bash-sandbox.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

export const DOCTOR_USAGE = `oma doctor - diagnose local CLI setup

Usage:
  oma doctor          check runtime, providers/models, tools, sandbox, and MCP config
  oma doctor --json   output the diagnostic report as JSON
`;

function findCatalogFile(env: Record<string, string | undefined>): string | undefined {
  const candidates = [
    ...(env.OMA_HOME ? [join(env.OMA_HOME, "models.yml")] : []),
    join(env.HOME ?? homedir(), ".oma", "models.yml"),
    resolve(".oma", "models.yml"),
  ];
  return candidates.find((p) => existsSync(p));
}

export async function runDoctorChecks(opts: {
  workspaceRoot: string;
  modelRuntime: ModelRuntime;
  env?: Record<string, string | undefined>;
}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const checks: DoctorCheck[] = [];

  // 1. Runtime
  checks.push({
    name: "runtime",
    status: "ok",
    detail: `Bun ${typeof Bun !== "undefined" ? Bun.version : "unknown"} (${process.platform}/${process.arch})`,
  });

  // 2. Model catalog & providers
  const catalogFile = findCatalogFile(env);
  try {
    loadRuntimeCatalog(env);
    const catalog = await opts.modelRuntime.getCatalog();
    const available = catalog.models.filter((m) => m.available !== false);
    const providers = [...new Set(available.map((m) => m.providerId))];
    if (available.length > 0) {
      checks.push({
        name: "models",
        status: "ok",
        detail: `${available.length} available model(s) across ${providers.join(", ")}${catalogFile ? ` (${catalogFile})` : ""}`,
      });
    } else {
      checks.push({
        name: "models",
        status: "fail",
        detail: `0 available models — run \`oma setup\` or set an API key (e.g. ANTHROPIC_API_KEY / OPENAI_API_KEY)${catalogFile ? `; loaded ${catalogFile}` : ""}`,
      });
    }
  } catch (err) {
    checks.push({
      name: "models",
      status: "fail",
      detail: `failed to load catalog${catalogFile ? ` (${catalogFile})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 3. ripgrep (used by grep tool)
  const rgPath = Bun.which("rg");
  checks.push({
    name: "ripgrep",
    status: rgPath ? "ok" : "warn",
    detail: rgPath ? rgPath : "rg not found on PATH (grep tool requires ripgrep)",
  });

  // 4. git (used by @ file picker, status bar, /diff, /rewind checkpoints)
  const gitPath = Bun.which("git");
  checks.push({
    name: "git",
    status: gitPath ? "ok" : "warn",
    detail: gitPath
      ? `${gitPath}${existsSync(join(opts.workspaceRoot, ".git")) ? " (repo detected)" : " (no .git in cwd)"}`
      : "git not found on PATH (/diff and /rewind checkpoints unavailable)",
  });

  // 5. OS bash sandbox (bwrap / sandbox-exec)
  try {
    resolveBashSandbox({ workspaceRoot: opts.workspaceRoot, enabled: true });
    const backend = process.platform === "darwin" ? "sandbox-exec" : "bwrap";
    checks.push({
      name: "sandbox",
      status: "ok",
      detail: `${backend} available for bash & orchestration isolation`,
    });
  } catch (err) {
    checks.push({
      name: "sandbox",
      status: "warn",
      detail: err instanceof Error ? err.message : "OS sandbox unavailable",
    });
  }

  // 6. Workspace settings & permission posture
  const settingsPath = join(opts.workspaceRoot, ".oma", "settings.json");
  const settings = loadProjectSettings(opts.workspaceRoot);
  if (existsSync(settingsPath)) {
    const trusted = isFileTrusted(settingsPath, readTrustedPlugins());
    checks.push({
      name: "settings",
      status: "ok",
      detail: `.oma/settings.json (${trusted ? "trusted" : "untrusted"}, permission=${settings.permissionMode ?? "default"}, model=${settings.model ?? "auto"})`,
    });
  } else {
    checks.push({
      name: "settings",
      status: "ok",
      detail: "no .oma/settings.json (using defaults)",
    });
  }

  // 7. Workspace .mcp.json
  const mcpPath = join(opts.workspaceRoot, ".mcp.json");
  if (existsSync(mcpPath)) {
    try {
      const parsed = JSON.parse(readFileSync(mcpPath, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      const names = Object.keys(parsed.mcpServers ?? {});
      const trusted = isFileTrusted(mcpPath, readTrustedPlugins());
      checks.push({
        name: "mcp",
        status: trusted || names.length === 0 ? "ok" : "warn",
        detail:
          names.length === 0
            ? ".mcp.json present (0 servers)"
            : `${names.length} server(s) in .mcp.json (${names.join(", ")}) — ${trusted ? "trusted" : "untrusted: run /mcp trust"}`,
      });
    } catch (err) {
      checks.push({
        name: "mcp",
        status: "fail",
        detail: `.mcp.json parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    checks.push({ name: "mcp", status: "ok", detail: "no workspace .mcp.json" });
  }

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon = (s: DoctorStatus): string => (s === "ok" ? "✔" : s === "warn" ? "⚠" : "✘");
  const lines = [
    "oma doctor",
    ...report.checks.map((c) => `  ${icon(c.status)} ${c.name.padEnd(10)} ${c.detail}`),
  ];
  lines.push(report.ok ? "Status: ready" : "Status: action required (see ✘ items above)");
  return lines.join("\n");
}

export async function runDoctorCommand(opts: {
  workspaceRoot: string;
  modelRuntime: ModelRuntime;
  json?: boolean;
}): Promise<number> {
  const report = await runDoctorChecks(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatDoctorReport(report)}\n`);
  }
  return report.ok ? 0 : 1;
}
