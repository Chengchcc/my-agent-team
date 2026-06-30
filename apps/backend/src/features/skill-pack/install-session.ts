import type { ChatModel } from "@my-agent-team/core";
import type { Plugin } from "@my-agent-team/framework";
import { AgentSession } from "@my-agent-team/harness";
import { progressiveSkillPlugin } from "@my-agent-team/plugin-progressive-skill";
import type { SkillPackSource } from "./entities.js";
import { posixSkillRoot } from "./entities.js";
import { nodeFsAdapter } from "./fs-adapter.js";
import type { SkillPackPort } from "./ports.js";
import { createAllPackTools } from "./tools.js";

// ─── Types ───

export interface InstallSessionDeps {
  model: ChatModel;
  dataDir: string;
  port: SkillPackPort;
}

export interface InstallSource {
  packId: string;
  sourceKind: SkillPackSource;
  sourceUrl: string | null;
  versionRef: string | null;
}

// ─── Helpers ───

function buildInstallPlugins(dataDir: string): Plugin[] {
  const sharedWs = nodeFsAdapter(posixSkillRoot(dataDir));
  return [
    progressiveSkillPlugin({
      ws: sharedWs,
      roots: ["builtin"],
      posixSkillRoot: posixSkillRoot(dataDir),
    }),
  ];
}

function buildPrompt(source: InstallSource, action: "install" | "sync"): string {
  const ctx = [
    `Task: ${action === "install" ? "Install" : "Sync"} skill pack.`,
    `Pack ID: ${source.packId}`,
    `Source kind: ${source.sourceKind}`,
  ];
  if (source.sourceUrl) {
    if (source.sourceKind === "git") {
      ctx.push(`Git URL: ${source.sourceUrl}`);
      if (source.versionRef) ctx.push(`Ref: ${source.versionRef}`);
    } else if (source.sourceKind === "zip") {
      ctx.push(`Zip data (base64): ${source.sourceUrl.slice(0, 50)}...`);
    }
  }
  ctx.push("", `Use the ${action} flow from skill-pack-installer to complete this task.`);
  if (action === "install") {
    ctx.push(`Target directory must be: ${source.packId}`);
  }
  return ctx.join("\n");
}

// ─── Session creation ───

async function createInstallSession(deps: InstallSessionDeps): Promise<AgentSession> {
  const sessionId = `install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new AgentSession({
    threadId: sessionId,
    model: deps.model,
    plugins: buildInstallPlugins(deps.dataDir),
    tools: createAllPackTools({ port: deps.port, dataDir: deps.dataDir }),
  });
}

// ─── Runners ───

export async function runInstall(source: InstallSource, deps: InstallSessionDeps): Promise<void> {
  const session = await createInstallSession(deps);
  try {
    await session.prompt(buildPrompt(source, "install"));
  } finally {
    const row = await deps.port.get(source.packId);
    if (row && row.status !== "ready" && row.status !== "failed") {
      await deps.port.applyInstallTransition(source.packId, "failed", {
        error: "install session ended without terminal status",
        now: Date.now(),
      });
    }
  }
}

export async function runSync(source: InstallSource, deps: InstallSessionDeps): Promise<void> {
  const session = await createInstallSession(deps);
  try {
    await session.prompt(buildPrompt(source, "sync"));
  } finally {
    const row = await deps.port.get(source.packId);
    if (row && row.status !== "ready" && row.status !== "failed") {
      await deps.port.applyInstallTransition(source.packId, "failed", {
        error: "sync session ended without terminal status",
        now: Date.now(),
      });
    }
  }
}
