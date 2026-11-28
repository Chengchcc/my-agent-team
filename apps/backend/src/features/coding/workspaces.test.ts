import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { AgentService } from "../agent/index.js";
import type { WorktreeOps } from "../project/worktree-ops.js";
import { createTerminalRegistry } from "./terminal-registry.js";
import { createCodingWorkspaceReader } from "./workspaces.js";

const MIGRATIONS = join(import.meta.dir, "../../../drizzle/backend");

describe("createCodingWorkspaceReader (ADR 0083 D2)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("aggregates open workspaces with human labels, git status, active ACP runs, pending approvals, and PTY terminals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coding-ws-reader-"));
    dirs.push(dir);
    const ws1Path = join(dir, "ws-1");
    const ws2Path = join(dir, "ws-2");
    mkdirSync(ws1Path, { recursive: true });
    mkdirSync(ws2Path, { recursive: true });

    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(drizzle(db), { migrationsFolder: MIGRATIONS });
    const now = Date.now();

    db.query(
      "INSERT INTO project (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("proj-1", "CrewDesk", now, now);
    db.query(
      "INSERT INTO requirement (requirement_id, title, goal, status, project_id, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)",
    ).run("req-1", "Build Herdr Coding UI", "Dual view", "proj-1", now, now);
    db.query(
      "INSERT INTO requirement (requirement_id, title, goal, status, project_id, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)",
    ).run("req-2", "Fix Billing Timeout", "Stabilize", "proj-1", now, now);
    db.query(
      "INSERT INTO conversation (conversation_id, agent_id, title, origin, current_requirement_id, project_id, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?)",
    ).run("conv-1", "coder", "Coding Architecture", "req-1", "proj-1", now);
    db.query(
      "INSERT INTO workspace (workspace_id, project_id, path, branch, base_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'HEAD', 'open', ?, ?)",
    ).run("ws-1", "proj-1", ws1Path, "req/req-1", now, now - 5_000);
    db.query(
      "INSERT INTO workspace (workspace_id, project_id, path, branch, base_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'HEAD', 'open', ?, ?)",
    ).run("ws-2", "proj-1", ws2Path, "req/req-2", now, now);
    db.query(
      "INSERT INTO requirement_workspace (requirement_id, workspace_id, created_at) VALUES (?, ?, ?)",
    ).run("req-1", "ws-1", now);
    db.query(
      "INSERT INTO requirement_workspace (requirement_id, workspace_id, created_at) VALUES (?, ?, ?)",
    ).run("req-2", "ws-2", now);

    // Seed an active waiting run with 1 pending approval on ws-1.
    db.query(
      "INSERT INTO agent_context_tree (tree_id, conversation_id, agent_id, created_at) VALUES (?, ?, ?, ?)",
    ).run("tree-1", "conv-1", "coder", now);
    db.query(
      "INSERT INTO agent_context_branch (branch_id, tree_id, backend_kind, is_default, created_at) VALUES (?, ?, 'acp', 1, ?)",
    ).run("br-1", "tree-1", now);
    db.query(
      `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, workspace_root, requirement_id, created_at)
       VALUES (?, ?, ?, ?, '{}', 'waiting', 'idem-1', 1, ?, ?, ?)`,
    ).run("run-1", "br-1", "conv-1", "coder", ws1Path, "req-1", now);
    db.query(
      "INSERT INTO pending_action (action_id, run_id, kind, payload, status, created_at) VALUES (?, ?, 'approval', '{}', 'pending', ?)",
    ).run("act-1", "run-1", now);

    const registry = createTerminalRegistry();
    const term = registry.spawn({
      projectId: "proj-1",
      agentId: "coder",
      workspaceId: "ws-2",
      requirementId: "req-2",
      cwd: ws2Path,
      title: "bash",
      command: { executable: "/bin/bash", args: ["-c", "sleep 30"] },
    });

    const agentSvc = {
      list: async () => [
        {
          id: "coder",
          workspacePath: dir,
          archivedAt: null,
          config: {
            name: "Lead Coder",
            enabled: true,
            runtime_config: {
              harness: "claude",
              projects: ["proj-1"],
            },
          },
        },
      ],
    } as unknown as AgentService;

    const worktreeOps = {
      status: async () => [
        {
          workspaceId: "ws-1",
          requirementId: "req-1",
          branch: "req/req-1",
          path: ws1Path,
          ahead: 3,
          behind: 0,
          worktreeReady: true,
        },
        {
          workspaceId: "ws-2",
          requirementId: "req-2",
          branch: "req/req-2",
          path: ws2Path,
          ahead: 0,
          behind: 1,
          worktreeReady: true,
        },
      ],
      diff: async () => "",
    } as WorktreeOps;

    const reader = createCodingWorkspaceReader({ db, agentSvc, worktreeOps, registry });
    const workspaces = await reader.listWorkspaces();
    registry.closeAll();

    // ws-1 is blocked (rank 0) so it sorts BEFORE ws-2 (running, rank 2) despite older updatedAt.
    expect(workspaces.map((w) => w.workspaceId)).toEqual(["ws-1", "ws-2"]);
    expect(workspaces[0]).toMatchObject({
      workspaceId: "ws-1",
      projectName: "CrewDesk",
      requirementTitle: "Build Herdr Coding UI",
      conversationId: "conv-1",
      conversationTitle: "Coding Architecture",
      defaultAgentId: "coder",
      defaultHarness: "claude",
      ahead: 3,
      state: "blocked",
      pendingActionCount: 1,
    });
    expect(workspaces[0]?.activeRuns[0]).toMatchObject({
      runId: "run-1",
      agentName: "Lead Coder",
      pendingActionCount: 1,
    });
    expect(workspaces[1]).toMatchObject({
      workspaceId: "ws-2",
      requirementTitle: "Fix Billing Timeout",
      state: "running",
      terminalIds: [term.terminalId],
    });
  });
});
