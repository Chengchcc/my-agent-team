#!/usr/bin/env bun
/**
 * Isolated headless demo capture: generates clean README screenshots and a
 * ~40s main-flow H.264 MP4 against the production Next.js build + isolated
 * SQLite backend + deterministic mock Anthropic SSE server.
 *
 * Usage:
 *   bun scripts/record-demo.ts                  # screenshots + demo MP4
 *   bun scripts/record-demo.ts --shots-only     # screenshots only
 *   bun scripts/record-demo.ts --video-only     # demo MP4 only
 */

import { Database } from "bun:sqlite";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SHOTS_DIR = join(ROOT, "docs/screenshots");
const VIDEO_OUT = process.env.DEMO_VIDEO_OUT ?? join(ROOT, "quality/demo-main-flow.mp4");
const DATA_DIR = "/tmp/oma-demo-data";
const DEMO_HOME = "/tmp/oma-demo-home";
const BACKEND_PORT = 13000;
const WEB_PORT = 13001;
const MOCK_PORT = 18099;
const AUTH_TOKEN = "demo-backend-token-0123456789";
const SESSION_SECRET = "demo-session-secret-0123456789abcdef0123456789";
const LOGIN_PASSWORD = "demo-password-2026";
const CHROME_BIN =
  process.env.CHROME_PATH ??
  ["/usr/bin/chromium", "/usr/bin/google-chrome"].find((p) => existsSync(p));
const FFMPEG_BIN = "/usr/bin/ffmpeg";

const ARGS = new Set(process.argv.slice(2));
const DO_SHOTS = !ARGS.has("--video-only");
const DO_VIDEO = !ARGS.has("--shots-only");

if (!CHROME_BIN) {
  throw new Error("No Chromium binary found. Install chromium or set CHROME_PATH.");
}
if (DO_VIDEO && !existsSync(FFMPEG_BIN)) {
  throw new Error("ffmpeg not found at /usr/bin/ffmpeg.");
}

// ── 1. Deterministic mock Anthropic SSE server ────────────────────────
function startMockAnthropic() {
  const sse = (name: string, payload: unknown) =>
    `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;

  const replyChunks = [
    "Done — I created Requirement ",
    "[Harden Stripe webhook idempotency](/requirements/req_demo_idempotency)",
    " and coordinated two workers:\n\n",
    "1. **Backend Coder (`claude`)** implemented atomic idempotency keys in an isolated git copy and pushed branch `agent/run_demo_coder`.\n",
    "2. **Security Reviewer (`pi`)** independently verified the diff and test suite (`42/42 passing`), clearing the **Delivery Gate**.\n\n",
    "Full verification report: `artifacts://reviews/idempotency-audit.md`\n",
  ];

  const server = Bun.serve({
    port: MOCK_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/messages")) {
        return new Response("not found", { status: 404 });
      }
      await req.text();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (name: string, payload: unknown) =>
            controller.enqueue(enc.encode(sse(name, payload)));

          send("message_start", {
            type: "message_start",
            message: {
              id: `msg_demo_${Date.now()}`,
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1420, output_tokens: 0 },
            },
          });
          send("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });
          for (const chunk of replyChunks) {
            send("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: chunk },
            });
            await Bun.sleep(160);
          }
          send("content_block_stop", { type: "content_block_stop", index: 0 });
          send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 96 },
          });
          send("message_stop", { type: "message_stop" });
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    },
  });
  return server;
}

// ── 2. Process lifecycle helpers ──────────────────────────────────────
const children: ChildProcess[] = [];

function spawnProc(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined>; label: string },
): ChildProcess {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stderr?.on("data", (buf: Buffer) => {
    const line = buf.toString().trim();
    if (line && process.env.DEMO_DEBUG === "1") {
      console.error(`[${opts.label}] ${line}`);
    }
  });
  return child;
}

async function waitForHttp(url: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // retry
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "x-auth-token": AUTH_TOKEN,
      "x-user-id": "operator",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${init.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

// ── 3. Seed clean, realistic English demo data ────────────────────────
async function seedDemoData(): Promise<{
  mainConvId: string;
  workflowId: string;
  executionId: string;
  reqId: string;
}> {
  const now = Date.now();

  // 3a. Update Personal Assistant (default) with clean English profile
  await api("/api/agents/default", {
    method: "PATCH",
    body: {
      name: "Personal Assistant",
      description:
        "Front-desk coordinator: triages requests, tracks Requirements, dispatches specialist workers, and maintains the Git Wiki.",
      model: "anthropic/claude-sonnet-4-5",
    },
  });

  // 3b. Create a clean demo project
  const { project } = await api<{ project: { projectId: string; name: string } }>("/api/projects", {
    method: "POST",
    body: {
      name: "acme-payments",
      repoUrl: "https://github.com/acme/payments-api",
      defaultBranch: "main",
    },
  });
  const projectId = project.projectId;

  // 3c. Remove auto-seeded default workers so the demo team has exactly 4 clean members across 4 harnesses
  const existingAgents = await api<Array<{ id: string; role: string | null }>>("/api/agents");
  const db = new Database(join(DATA_DIR, "backend.db"));
  for (const a of existingAgents) {
    if (a.id !== "default") {
      db.query("DELETE FROM agents WHERE id = ?").run(a.id);
    }
  }

  // Create 3 specialist workers across claude / pi / omp
  const workerSpecs = [
    {
      name: "Backend Coder",
      description:
        "Implements TypeScript/Bun services in isolated git copies and pushes verified changes to agent/<runId> branches.",
      harness: "claude",
      model: "anthropic/claude-sonnet-4-5",
      permissionMode: "ask" as const,
      skills: [{ id: "ts-backend", description: "TypeScript & Drizzle backend patterns" }],
    },
    {
      name: "Security Reviewer",
      description:
        "Independent second-agent reviewer that audits diffs, verifies test suites, and clears the Delivery Gate.",
      harness: "pi",
      model: "deepseek/deepseek-v4-pro",
      permissionMode: "ask" as const,
      skills: [{ id: "security-audit", description: "OWASP & auth boundary verification" }],
    },
    {
      name: "Infra Researcher",
      description:
        "Investigates architecture trade-offs, profiles SQLite/runtime metrics, and drafts Git Wiki RFCs.",
      harness: "omp",
      model: "anthropic/claude-haiku-4-5",
      permissionMode: "auto" as const,
      skills: [{ id: "perf-profiling", description: "Latency & memory profiling" }],
    },
  ];

  const createdAgents: Record<string, string> = { default: "default" };

  for (const spec of workerSpecs) {
    const created = await api<{ id: string }>("/api/agents", {
      method: "POST",
      body: {
        name: spec.name,
        description: spec.description,
        role: "worker",
        harness: spec.harness,
        model: spec.model,
        permissionMode: spec.permissionMode,
        skills: spec.skills,
      },
    });
    createdAgents[spec.name] = created.id;
    await api(`/api/agents/${created.id}`, {
      method: "PATCH",
      body: { projects: [projectId] },
    });
  }

  // Bind project to PA as well
  await api("/api/agents/default", {
    method: "PATCH",
    body: { projects: [projectId] },
  });

  // 3d. Seed MCP servers catalog
  for (const srv of [
    {
      id: "github-mcp",
      name: "GitHub MCP",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      enabled: true,
    },
    {
      id: "postgres-ro",
      name: "Analytics DB (Read-Only)",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres"],
      enabled: true,
    },
  ]) {
    try {
      await api("/api/mcp/servers", { method: "POST", body: srv });
    } catch {
      // non-fatal if schema differs
    }
  }

  // 3e. Seed Conversations, Requirements, Runs, Ledger Messages, Artifacts
  const mainConvId = "conv_demo_main";
  const secondConvId = "conv_demo_ed25519";
  const thirdConvId = "conv_demo_release";
  const coderConvId = "conv_demo_coder_child";
  const reqId = "req_demo_idempotency";
  const req2Id = "req_demo_ed25519";
  const req3Id = "req_demo_wal";
  const coderId = createdAgents["Backend Coder"]!;
  const reviewerId = createdAgents["Security Reviewer"]!;
  const researcherId = createdAgents["Infra Researcher"]!;

  // Insert requirements first (FK referenced by conversation.current_requirement_id)
  db.query(
    `INSERT INTO requirement (
      requirement_id, title, goal, background, constraints,
      expected_deliverables, acceptance_criteria, status,
      project_id, origin_conversation_id, origin_seq,
      created_by_agent_id, created_at, updated_at, accepted_at, accepted_evidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reqId,
    "Harden Stripe webhook idempotency",
    "Enforce atomic idempotency key deduplication on /webhooks/stripe so retried deliveries never double-charge or emit duplicate ledger entries.",
    "Stripe retries webhooks on 5xx and timeouts; concurrent retries currently race before the transaction commits.",
    "No schema downtime; push changes only to agent/<runId> branch; require independent review by Security Reviewer before Delivery Gate clears.",
    "1. Atomic idempotency guard + Drizzle migration\n2. Concurrency regression tests\n3. Security audit artifact",
    "All 42 unit & race-condition tests pass; Security Reviewer signs off with zero high/medium findings.",
    "open",
    projectId,
    mainConvId,
    1,
    "default",
    now - 42 * 60_000,
    now - 4 * 60_000,
    null,
    null,
  );

  db.query(
    `INSERT INTO requirement (
      requirement_id, title, goal, background, constraints,
      expected_deliverables, acceptance_criteria, status,
      project_id, origin_conversation_id, origin_seq,
      created_by_agent_id, created_at, updated_at, accepted_at, accepted_evidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    req2Id,
    "Rotate session signing keys to Ed25519",
    "Support dual-key verification window during Ed25519 key rotation without invalidating active browser sessions.",
    "Security compliance requires 90-day asymmetric key rotation for BFF session cookies.",
    "Keep HMAC fallback readable for 24h grace window; zero forced logouts.",
    "Keyring loader, rotation CLI script, and rollout runbook in Git Wiki.",
    "Old and new tokens verify cleanly during grace window; expired keys fail closed.",
    "open",
    projectId,
    secondConvId,
    1,
    "default",
    now - 3 * 3600_000,
    now - 25 * 60_000,
    null,
    null,
  );

  db.query(
    `INSERT INTO requirement (
      requirement_id, title, goal, background, constraints,
      expected_deliverables, acceptance_criteria, status,
      project_id, origin_conversation_id, origin_seq,
      created_by_agent_id, created_at, updated_at, accepted_at, accepted_evidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    req3Id,
    "SQLite WAL checkpoint tuning",
    "Cap WAL growth under sustained SSE fan-out while keeping p99 write latency below 8ms.",
    "Long-running agent runs caused occasional 120MB WAL spikes during nightly batch workflows.",
    "Must remain single-file SQLite with zero external dependencies.",
    "Tuned pragma profile + benchmark report in Git Wiki.",
    "30-minute load sample shows p99 < 8ms and WAL < 16MB.",
    "done",
    projectId,
    thirdConvId,
    1,
    "default",
    now - 26 * 3600_000,
    now - 18 * 3600_000,
    now - 18 * 3600_000,
    JSON.stringify(["run:run_demo_wal pass"]),
  );

  // Conversations
  const insertConv = db.query(
    `INSERT INTO conversation (
      conversation_id, agent_id, hop_count, title, origin, created_at,
      current_requirement_id, project_id, parent_conversation_id
    ) VALUES (?, ?, 0, ?, 'user', ?, ?, ?, ?)`,
  );
  insertConv.run(
    mainConvId,
    "default",
    "Harden Stripe webhook idempotency",
    now - 45 * 60_000,
    reqId,
    projectId,
    null,
  );
  insertConv.run(
    coderConvId,
    coderId,
    "implement · webhook idempotency guard",
    now - 28 * 60_000,
    reqId,
    projectId,
    mainConvId,
  );
  insertConv.run(
    secondConvId,
    "default",
    "Ed25519 session key rotation plan",
    now - 3 * 3600_000,
    req2Id,
    projectId,
    null,
  );
  insertConv.run(
    thirdConvId,
    "default",
    "SQLite WAL tuning & v0.9 release notes",
    now - 26 * 3600_000,
    req3Id,
    projectId,
    null,
  );

  // Link conversations <-> requirements (ADR 0077/0082)
  const linkCR = db.query(
    `INSERT INTO conversation_requirement (conversation_id, requirement_id, created_at) VALUES (?, ?, ?)`,
  );
  linkCR.run(mainConvId, reqId, now - 42 * 60_000);
  linkCR.run(coderConvId, reqId, now - 28 * 60_000);
  linkCR.run(secondConvId, req2Id, now - 3 * 3600_000);
  linkCR.run(thirdConvId, req3Id, now - 26 * 3600_000);

  // Context trees & branches + completed Agent Runs
  const insertTree = db.query(
    `INSERT INTO agent_context_tree (tree_id, conversation_id, agent_id, created_at) VALUES (?, ?, ?, ?)`,
  );
  const insertBranch = db.query(
    `INSERT INTO agent_context_branch (branch_id, tree_id, ledger_cursor, backend_kind, is_default, revision, created_at) VALUES (?, ?, ?, ?, 1, 1, ?)`,
  );
  insertTree.run("tree_demo_main", mainConvId, "default", now - 45 * 60_000);
  insertBranch.run("branch_demo_main", "tree_demo_main", 4, "acp", now - 45 * 60_000);
  insertTree.run("tree_demo_coder", coderConvId, coderId, now - 28 * 60_000);
  insertBranch.run("branch_demo_coder", "tree_demo_coder", 2, "acp", now - 28 * 60_000);
  insertTree.run("tree_demo_rev", thirdConvId, reviewerId, now - 14 * 60_000);
  insertBranch.run("branch_demo_rev", "tree_demo_rev", 1, "acp", now - 14 * 60_000);
  insertTree.run("tree_demo_wal", thirdConvId, researcherId, now - 20 * 3600_000);
  insertBranch.run("branch_demo_wal", "tree_demo_wal", 1, "acp", now - 20 * 3600_000);

  const insertRun = db.query(
    `INSERT INTO agent_run (
      run_id, branch_id, conversation_id, agent_id, model_ref, status,
      idempotency_key, terminal_result, config_revision, authorization,
      requirement_id, created_at, terminal_at, result_notified_at, result_seen_at
    ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  );

  insertRun.run(
    "run_demo_pa_1",
    "branch_demo_main",
    mainConvId,
    "default",
    JSON.stringify({
      backendKind: "acp",
      modelId: "acp/oma",
      harnessModel: "anthropic/claude-sonnet-4-5",
      reasoningEffort: "high",
    }),
    "idem_demo_pa_1",
    JSON.stringify({
      status: "completed",
      messages: [{ role: "assistant", text: "Dispatched Backend Coder and Security Reviewer." }],
      usage: { inputTokens: 12480, outputTokens: 612, cacheReadTokens: 8900 },
    }),
    "user",
    reqId,
    now - 40 * 60_000,
    now - 39 * 60_000,
    now - 39 * 60_000,
    now - 38 * 60_000,
  );

  insertRun.run(
    "run_demo_coder",
    "branch_demo_coder",
    coderConvId,
    coderId,
    JSON.stringify({
      backendKind: "acp",
      modelId: "acp/claude",
      harnessModel: "anthropic/claude-sonnet-4-5",
    }),
    "idem_demo_coder",
    JSON.stringify({
      status: "completed",
      messages: [
        {
          role: "assistant",
          blocks: [
            { type: "tool_use", name: "bash", input: { command: "bun test webhook-idempotency" } },
            { type: "tool_result", is_error: false, content: "42 pass, 0 fail" },
            { type: "text", text: "Pushed verified changes to agent/run_demo_coder." },
          ],
        },
      ],
      usage: { inputTokens: 34200, outputTokens: 2140, cacheReadTokens: 24100 },
    }),
    "dispatch:default",
    reqId,
    now - 26 * 60_000,
    now - 18 * 60_000,
    now - 18 * 60_000,
    now - 15 * 60_000,
  );

  insertRun.run(
    "run_demo_reviewer",
    "branch_demo_rev",
    mainConvId,
    reviewerId,
    JSON.stringify({
      backendKind: "acp",
      modelId: "acp/pi",
      harnessModel: "deepseek/deepseek-v4-pro",
    }),
    "idem_demo_reviewer",
    JSON.stringify({
      status: "completed",
      messages: [
        {
          role: "assistant",
          blocks: [
            { type: "tool_use", name: "bash", input: { command: "bun run typecheck && bun test" } },
            { type: "tool_result", is_error: false, content: "all checks green" },
            { type: "text", text: "Independent review passed with zero findings." },
          ],
        },
      ],
      usage: { inputTokens: 19800, outputTokens: 980, cacheReadTokens: 14200 },
    }),
    "dispatch:default",
    reqId,
    now - 16 * 60_000,
    now - 9 * 60_000,
    now - 9 * 60_000,
    now - 5 * 60_000,
  );

  insertRun.run(
    "run_demo_wal",
    "branch_demo_wal",
    thirdConvId,
    researcherId,
    JSON.stringify({
      backendKind: "acp",
      modelId: "acp/omp",
      harnessModel: "anthropic/claude-haiku-4-5",
    }),
    "idem_demo_wal",
    JSON.stringify({
      status: "completed",
      messages: [
        {
          role: "assistant",
          blocks: [
            { type: "tool_use", name: "bash", input: { command: "bun test sqlite-wal" } },
            { type: "tool_result", is_error: false, content: "p99 4.2ms, WAL 11MB" },
            { type: "text", text: "WAL tuning verified and logged to Git Wiki." },
          ],
        },
      ],
      usage: { inputTokens: 11200, outputTokens: 640 },
    }),
    "dispatch:default",
    req3Id,
    now - 20 * 3600_000,
    now - 19 * 3600_000,
    now - 19 * 3600_000,
    now - 18 * 3600_000,
  );

  // Upload real artifacts via API (writes both disk + SQLite artifact index!)
  await api("/api/artifacts/", {
    method: "POST",
    body: {
      folder: "reviews",
      filename: "idempotency-audit.md",
      content: [
        "# Security & Concurrency Audit — Stripe Webhook Idempotency",
        "",
        "- **Branch**: `agent/run_demo_coder`",
        "- **Implementer**: Backend Coder (`claude` harness)",
        "- **Verifier**: Security Reviewer (`pi` harness)",
        "- **Delivery Gate**: Verified (2nd-agent sign-off)",
        "",
        "## Checks",
        "",
        "| Suite | Result | Duration |",
        "|---|---|---|",
        "| `webhook-idempotency.test.ts` (parallel race) | 18 / 18 passed | 1.4s |",
        "| `payments-ledger.test.ts` | 24 / 24 passed | 2.1s |",
        "| `bun run typecheck` | 0 errors | 3.8s |",
        "",
        "## Findings",
        "- Zero high/medium findings. `INSERT OR IGNORE` unique index on `(provider, event_id)` closes the TOCTOU window.",
        "- Verified `project_push` target is `agent/run_demo_coder` (`main` untouched).",
      ].join("\n"),
      source: {
        runId: "run_demo_reviewer",
        conversationId: mainConvId,
        requirementId: reqId,
        agentId: reviewerId,
        projectId,
      },
    },
  });

  await api("/api/artifacts/", {
    method: "POST",
    body: {
      folder: "benchmarks",
      filename: "sqlite-wal-30m-sample.md",
      content: [
        "# SQLite WAL 30-Minute Load Sample",
        "",
        "- **p50 commit latency**: `1.1 ms`",
        "- **p99 commit latency**: `4.2 ms` (target `< 8 ms`)",
        "- **Peak WAL size**: `11.4 MB` (capped under 16 MB)",
        "- **Config**: `PRAGMA wal_autocheckpoint = 1000; PRAGMA busy_timeout = 5000;`",
      ].join("\n"),
      source: {
        runId: "run_demo_wal",
        conversationId: thirdConvId,
        requirementId: req3Id,
        agentId: researcherId,
        projectId,
      },
    },
  });

  // Seed rich conversation ledger rows
  const insertLedger = db.query(
    `INSERT INTO conversation_ledger (
      conversation_id, kind, content, ts, agent_run_id, message_index, undone, saved
    ) VALUES (?, 'message', ?, ?, ?, ?, 0, ?)`,
  );

  insertLedger.run(
    mainConvId,
    JSON.stringify({
      messageId: `msg:${mainConvId}:user:1`,
      state: "done",
      role: "user",
      text: "Harden the `/webhooks/stripe` handler in `acme-payments` with atomic idempotency keys so retried webhooks never double-charge. Have Security Reviewer verify the diff before pushing.",
      conversationId: mainConvId,
      visibility: "conversation",
      updatedAt: now - 42 * 60_000,
    }),
    now - 42 * 60_000,
    null,
    0,
    0,
  );

  insertLedger.run(
    mainConvId,
    JSON.stringify({
      messageId: "run:run_demo_pa_1:assistant:0",
      state: "done",
      role: "assistant",
      text: [
        "Tracked this goal under [Harden Stripe webhook idempotency](/requirements/req_demo_idempotency) and dispatched two specialist workers:",
        "",
        "| Role | Harness | Scope | Status |",
        "|---|---|---|---|",
        "| **Backend Coder** | `claude` | Implement atomic `(provider, event_id)` guard + concurrency tests in isolated git copy | Pushed `agent/run_demo_coder` |",
        "| **Security Reviewer** | `pi` | Audit race conditions, verify test suite, clear Delivery Gate | Passed (`42/42`) |",
        "",
        "### Key Diff (`apps/payments/webhook.ts`)",
        "```ts",
        "const claimed = await db.insert(webhookEvent)",
        "  .values({ provider: 'stripe', eventId: evt.id, receivedAt: Date.now() })",
        "  .onConflictDoNothing()",
        "  .returning({ id: webhookEvent.eventId });",
        "if (claimed.length === 0) return Response.json({ deduplicated: true });",
        "```",
        "",
        "Independent verification report: `artifacts://reviews/idempotency-audit.md`",
        "",
        "Everything is pushed to `agent/run_demo_coder` (`main` untouched). Ready for your merge decision whenever you want.",
      ].join("\n"),
      conversationId: mainConvId,
      visibility: "conversation",
      updatedAt: now - 9 * 60_000,
    }),
    now - 9 * 60_000,
    "run_demo_pa_1",
    0,
    1,
  );

  insertLedger.run(
    secondConvId,
    JSON.stringify({
      messageId: `msg:${secondConvId}:user:1`,
      state: "done",
      role: "user",
      text: "Draft a zero-downtime rollout plan to rotate BFF session cookies to Ed25519 keys.",
      conversationId: secondConvId,
      visibility: "conversation",
      updatedAt: now - 3 * 3600_000,
    }),
    now - 3 * 3600_000,
    null,
    0,
    0,
  );

  // 3f. Seed Workflow definition + waiting_human execution
  const workflowId = "nightly-quality-gate";
  const executionId = "exec_demo_quality_01";
  const workflowDef = {
    version: 1,
    id: workflowId,
    meta: {
      name: "Nightly Quality & Security Gate",
      description:
        "Scans acme-payments, runs sandboxed benchmark & audit scripts, and pauses at a human sign-off gate before publishing.",
      tags: ["nightly", "security", "quality"],
      status: "active",
      owner: "platform",
      updatedBy: "oma",
    },
    input: [{ key: "repoUrl", type: "string" }],
    nodes: [
      { id: "start", type: "start" },
      {
        id: "scan-repo",
        type: "agent",
        agentId: reviewerId,
        model: "deepseek/deepseek-v4-pro",
        prompt:
          "Audit recent commits for concurrency bugs, auth boundary leaks, and missing tests.",
        output: [{ key: "findings", type: "string" }],
      },
      {
        id: "sandbox-verify",
        type: "script",
        runtime: "bun",
        timeoutMs: 30000,
        code: "export default async function run({ input }) {\n  return { passed: 42, warnings: 0, summary: 'All 42 suites green inside bubblewrap sandbox' };\n}",
        output: [{ key: "summary", type: "string" }],
      },
      {
        id: "release-signoff",
        type: "human",
        question:
          "Nightly audit passed (42/42 tests, 0 security findings). Publish release candidate?",
        form: {
          decision: {
            type: "enum",
            label: "Decision",
            options: ["approve", "hold"],
            required: true,
          },
          note: {
            type: "textarea",
            label: "Release Note",
            required: false,
          },
        },
        output: [
          { key: "decision", type: "string" },
          { key: "note", type: "string" },
        ],
      },
      { id: "published", type: "end", status: "success" },
      { id: "held", type: "end", status: "dismissed" },
    ],
    edges: [
      { from: "start", to: "scan-repo" },
      { from: "scan-repo", to: "sandbox-verify" },
      { from: "sandbox-verify", to: "release-signoff" },
      {
        from: "release-signoff",
        to: "published",
        when: { "==": [{ var: "release-signoff.output.decision" }, "approve"] },
      },
      {
        from: "release-signoff",
        to: "held",
        when: { "==": [{ var: "release-signoff.output.decision" }, "hold"] },
      },
    ],
  };

  const wfDir = join(DATA_DIR, "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(
    join(wfDir, `${workflowId}.workflow.json`),
    JSON.stringify(workflowDef, null, 2),
    "utf8",
  );

  db.query(
    `INSERT INTO workflow_execution (
      execution_id, workflow_id, triggered_by, definition, input, store,
      status, requirement_id, conversation_id, project_id, created_at
    ) VALUES (?, ?, 'cron:0 2 * * *', ?, ?, ?, 'waiting_human', ?, ?, ?, ?)`,
  ).run(
    executionId,
    workflowId,
    JSON.stringify(workflowDef),
    JSON.stringify({ repoUrl: "https://github.com/acme/payments-api" }),
    JSON.stringify({
      "scan-repo": { findings: [] },
      "sandbox-verify": { passed: 42, warnings: 0 },
    }),
    reqId,
    mainConvId,
    projectId,
    now - 4 * 60_000,
  );

  const insertNodeRun = db.query(
    `INSERT INTO workflow_node_run (
      execution_id, node_id, run_id, status, "order", output, routed_to, created_at, terminal_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertNodeRun.run(
    executionId,
    "start",
    null,
    "completed",
    0,
    JSON.stringify({ repoUrl: "https://github.com/acme/payments-api" }),
    JSON.stringify(["scan-repo"]),
    now - 4 * 60_000,
    now - 4 * 60_000 + 800,
  );
  insertNodeRun.run(
    executionId,
    "scan-repo",
    "run_demo_reviewer",
    "completed",
    1,
    JSON.stringify({ findings: [] }),
    JSON.stringify(["sandbox-verify"]),
    now - 4 * 60_000 + 1000,
    now - 2 * 60_000,
  );
  insertNodeRun.run(
    executionId,
    "sandbox-verify",
    null,
    "completed",
    2,
    JSON.stringify({
      passed: 42,
      warnings: 0,
      summary: "All 42 suites green inside bubblewrap sandbox",
    }),
    JSON.stringify(["release-signoff"]),
    now - 2 * 60_000 + 500,
    now - 90_000,
  );
  insertNodeRun.run(
    executionId,
    "release-signoff",
    null,
    "waiting_human",
    3,
    null,
    null,
    now - 88_000,
    null,
  );

  const insertWfEvent = db.query(
    `INSERT INTO workflow_execution_event (execution_id, event, data, ts) VALUES (?, ?, ?, ?)`,
  );
  insertWfEvent.run(
    executionId,
    "node_started",
    JSON.stringify({ nodeId: "start" }),
    now - 4 * 60_000,
  );
  insertWfEvent.run(
    executionId,
    "node_completed",
    JSON.stringify({ nodeId: "start", routedTo: ["scan-repo"] }),
    now - 4 * 60_000 + 800,
  );
  insertWfEvent.run(
    executionId,
    "node_completed",
    JSON.stringify({ nodeId: "scan-repo", routedTo: ["sandbox-verify"] }),
    now - 2 * 60_000,
  );
  insertWfEvent.run(
    executionId,
    "node_completed",
    JSON.stringify({ nodeId: "sandbox-verify", routedTo: ["release-signoff"] }),
    now - 90_000,
  );
  insertWfEvent.run(
    executionId,
    "human_task_requested",
    JSON.stringify({ nodeId: "release-signoff" }),
    now - 88_000,
  );

  db.query(
    `INSERT INTO workflow_pending_human (
      execution_id, node_id, question, form, status, created_at
    ) VALUES (?, 'release-signoff', ?, ?, 'pending', ?)`,
  ).run(
    executionId,
    "Nightly audit passed (42/42 tests, 0 security findings). Publish release candidate?",
    JSON.stringify(workflowDef.nodes[3]!.form),
    now - 88_000,
  );

  // 3g. Seed Git-Backed Wiki with interconnected pages (drives Wiki Graph!)
  const wikiDir = join(DATA_DIR, "wiki");
  for (const sub of ["decisions", "projects", "concepts", "lessons"]) {
    mkdirSync(join(wikiDir, sub), { recursive: true });
  }
  const todayIso = "2026-11-26";
  const wikiFiles: Record<string, string> = {
    "projects/acme-payments.md": [
      "---",
      "title: Acme Payments API",
      "maintainedBy: default",
      "status: confirmed",
      `updated: ${todayIso}`,
      "sources:",
      `  - conversation:${mainConvId}:1-2`,
      "---",
      "",
      "Core billing and webhook service owned by the engineering agent team.",
      "",
      "## Architecture Notes",
      "- Webhook ingestion follows [[Stripe Webhook Idempotency]] to guarantee at-most-once ledger writes.",
      "- All worker branches must pass the [[Two-Agent Delivery Gate]] before merge.",
      "- Local persistence uses tuned SQLite settings documented in [[SQLite WAL Tuning]].",
      "",
    ].join("\n"),
    "decisions/idempotency-keys.md": [
      "---",
      "title: Stripe Webhook Idempotency",
      "maintainedBy: default",
      "status: confirmed",
      `updated: ${todayIso}`,
      "sources:",
      `  - conversation:${mainConvId}:1-2`,
      "---",
      "",
      "Every incoming Stripe webhook claims `(provider, event_id)` via `INSERT ... ON CONFLICT DO NOTHING RETURNING` before mutating balances.",
      "",
      "- Eliminates TOCTOU race windows during concurrent webhook retries in [[Acme Payments API]].",
      "- Verified by Security Reviewer under the [[Two-Agent Delivery Gate]].",
      "",
    ].join("\n"),
    "concepts/delivery-gate.md": [
      "---",
      "title: Two-Agent Delivery Gate",
      "maintainedBy: default",
      "status: confirmed",
      `updated: ${todayIso}`,
      "sources:",
      `  - conversation:${mainConvId}:1-2`,
      "---",
      "",
      "Changes pushed by a coding worker to `agent/<runId>` stay flagged **Unverified** until a second specialist agent independently runs tests and reviews the diff.",
      "",
      "- Applied across [[Acme Payments API]] and all critical [[Stripe Webhook Idempotency]] changes.",
      "",
    ].join("\n"),
    "lessons/sqlite-wal-tuning.md": [
      "---",
      "title: SQLite WAL Tuning",
      "maintainedBy: default",
      "status: confirmed",
      `updated: ${todayIso}`,
      "sources:",
      `  - conversation:${thirdConvId}:1-1`,
      "---",
      "",
      "Setting `wal_autocheckpoint = 1000` and `busy_timeout = 5000` keeps WAL under 16 MB and p99 commits at 4.2 ms during sustained SSE fan-out in [[Acme Payments API]].",
      "",
    ].join("\n"),
  };
  for (const [rel, body] of Object.entries(wikiFiles)) {
    writeFileSync(join(wikiDir, rel), body, "utf8");
  }
  if (!existsSync(join(wikiDir, ".git"))) {
    execFileSync("git", ["init", "-q"], { cwd: wikiDir });
    execFileSync("git", ["config", "user.name", "Personal Assistant"], { cwd: wikiDir });
    execFileSync("git", ["config", "user.email", "pa@my-agent-team.local"], { cwd: wikiDir });
  }
  execFileSync("git", ["add", "."], { cwd: wikiDir });
  try {
    execFileSync("git", ["commit", "-q", "-m", "wiki: seed engineering team knowledge"], {
      cwd: wikiDir,
    });
  } catch {
    // already committed
  }

  db.close();
  return { mainConvId, workflowId, executionId, reqId };
}

// ── 4. Visual overlay helper for crisp demo recording ─────────────────
async function injectDemoOverlay(page: any, caption: string) {
  await page.evaluate((text: string) => {
    let style = document.getElementById("__demo_style");
    if (!style) {
      style = document.createElement("style");
      style.id = "__demo_style";
      style.textContent = `
        nextjs-portal, #__next-build-watcher, [data-nextjs-toast] { display: none !important; }
        #__demo_pill {
          position: fixed;
          bottom: 22px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 999999;
          padding: 10px 20px;
          border-radius: 999px;
          background: rgba(16, 18, 20, 0.88);
          border: 1px solid rgba(180, 241, 209, 0.45);
          color: #eff1ee;
          font: 500 14px/1.3 Inter, -apple-system, BlinkMacSystemFont, sans-serif;
          letter-spacing: 0.01em;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
          backdrop-filter: blur(10px);
          pointer-events: none;
          transition: opacity 220ms ease;
        }
        #__demo_pill b { color: #b4f1d1; font-weight: 600; margin-right: 8px; }
        @keyframes __demo_pulse {
          0%, 100% { box-shadow: 0 0 0 4px rgba(180, 241, 209, 0.20); }
          50% { box-shadow: 0 0 0 8px rgba(180, 241, 209, 0.34); }
        }
        #__demo_cursor {
          position: fixed;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: rgba(180, 241, 209, 0.90);
          border: 2px solid #101214;
          animation: __demo_pulse 1.4s ease-in-out infinite;
          pointer-events: none;
          z-index: 999999;
          transform: translate(-50%, -50%);
          transition: left 420ms cubic-bezier(.2,.8,.2,1), top 420ms cubic-bezier(.2,.8,.2,1), transform 140ms ease;
        }
        #__demo_cursor.clicking { transform: translate(-50%, -50%) scale(0.75); }
      `;
      document.head.appendChild(style);
    }
    let pill = document.getElementById("__demo_pill");
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "__demo_pill";
      document.body.appendChild(pill);
    }
    const [step, ...rest] = text.split(" · ");
    pill.innerHTML = rest.length > 0 ? `<b>${step}</b>${rest.join(" · ")}` : text;

    let cursor = document.getElementById("__demo_cursor");
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = "__demo_cursor";
      cursor.style.left = "640px";
      cursor.style.top = "360px";
      document.body.appendChild(cursor);
    }
  }, caption);
}

async function moveCursorTo(page: any, x: number, y: number, click = false) {
  await page.evaluate(
    ({ tx, ty, doClick }: { tx: number; ty: number; doClick: boolean }) => {
      const c = document.getElementById("__demo_cursor");
      if (!c) return;
      c.style.left = `${tx}px`;
      c.style.top = `${ty}px`;
      if (doClick) {
        setTimeout(() => c.classList.add("clicking"), 340);
        setTimeout(() => c.classList.remove("clicking"), 520);
      }
    },
    { tx: x, ty: y, doClick: click },
  );
  await Bun.sleep(click ? 580 : 450);
}

// ── 5. Main execution ─────────────────────────────────────────────────
async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(DEMO_HOME, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(join(DEMO_HOME, ".oma"), { recursive: true });
  mkdirSync(join(DEMO_HOME, "bin"), { recursive: true });
  mkdirSync(SHOTS_DIR, { recursive: true });

  // Provide isolated PATH shims for claude/pi/omp so the harness readiness probe shows all 4 harnesses available
  for (const bin of ["claude", "pi", "omp"]) {
    const p = join(DEMO_HOME, "bin", bin);
    writeFileSync(p, '#!/bin/sh\necho "1.0.0"\nexit 0\n');
    chmodSync(p, 0o755);
  }

  const mockServer = startMockAnthropic();
  let browser: any = null;

  try {
    console.log("==> Starting isolated backend (:13000) and production web (:13001)...");
    spawnProc("bun", ["src/main.ts"], {
      cwd: join(ROOT, "apps/backend"),
      label: "backend",
      env: {
        ...process.env,
        PATH: `${join(DEMO_HOME, "bin")}:/root/.bun/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: DEMO_HOME,
        OMA_HOME: join(DEMO_HOME, ".oma"),
        BACKEND_PORT: String(BACKEND_PORT),
        BACKEND_HOST: "127.0.0.1",
        PRODUCT_TOOLS_MCP_URL: "http://127.0.0.1:13005",
        BACKEND_DATA_DIR: DATA_DIR,
        BACKEND_AUTH_TOKEN: AUTH_TOKEN,
        MOCK_PASSWORD: LOGIN_PASSWORD,
        ANTHROPIC_API_KEY: "sk-ant-demo-mock",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
        WORKFLOW_SCRIPTS_ENABLED: "1",
      },
    });
    await waitForHttp(`http://127.0.0.1:${BACKEND_PORT}/health`);

    const seed = await seedDemoData();
    console.log("==> Demo data seeded:", seed);

    spawnProc(
      "bun",
      ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(WEB_PORT)],
      {
        cwd: join(ROOT, "apps/web"),
        label: "web",
        env: {
          ...process.env,
          NODE_ENV: "production",
          BACKEND_URL: `http://127.0.0.1:${BACKEND_PORT}`,
          BACKEND_AUTH_TOKEN: AUTH_TOKEN,
          SESSION_SECRET,
          MOCK_PASSWORD: LOGIN_PASSWORD,
          MOCK_USER_ID: "operator",
        },
      },
    );
    await waitForHttp(`http://127.0.0.1:${WEB_PORT}/login`);

    const puppeteer = (
      await import("../apps/web/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js")
    ).default;

    mkdirSync(join(DEMO_HOME, ".config"), { recursive: true });
    mkdirSync(join(DEMO_HOME, ".cache"), { recursive: true });
    mkdirSync(join(DEMO_HOME, "chrome-profile"), { recursive: true });

    browser = await puppeteer.launch({
      executablePath: CHROME_BIN,
      userDataDir: join(DEMO_HOME, "chrome-profile"),
      env: {
        ...process.env,
        HOME: DEMO_HOME,
        XDG_CONFIG_HOME: join(DEMO_HOME, ".config"),
        XDG_CACHE_HOME: join(DEMO_HOME, ".cache"),
        XDG_DATA_HOME: "/root/.local/share",
      },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-crash-reporter",
        "--no-first-run",
        "--headless=new",
        "--font-render-hinting=none",
      ],
    });

    const page = await browser.newPage();
    const BASE = `http://127.0.0.1:${WEB_PORT}`;

    // Force English UI locale cookie before first navigation
    await page.setCookie({
      name: "ui.locale",
      value: "en",
      url: BASE,
      path: "/",
    });

    // Login via UI form
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
    await page.type('input[type="password"]', LOGIN_PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20_000 }),
      page.click('button[type="submit"], button'),
    ]);
    console.log("==> Logged into console:", page.url());

    // Helper: navigate & wait until CSS + React Query + ONLINE status pill are genuinely hydrated
    async function waitForHydrated(extraMs = 800) {
      await page
        .waitForFunction(
          () => {
            const bg = getComputedStyle(document.body).backgroundColor;
            if (bg === "rgb(255, 255, 255)" || bg === "rgba(0, 0, 0, 0)") return false;
            const txt = document.body?.innerText ?? "";
            const online = txt.includes("ONLINE") || txt.includes("SLOW");
            return (
              online &&
              !txt.includes("CHECKING...") &&
              !txt.includes("Checking...") &&
              !txt.includes("Loading...")
            );
          },
          { timeout: 20_000 },
        )
        .catch(() => {});
      await Bun.sleep(extraMs);
    }

    async function openPage(path: string, settleMs = 900) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForSelector("main, h1", { timeout: 15_000 }).catch(() => {});
      await page.addStyleTag({
        content: "nextjs-portal, #__next-build-watcher { display: none !important; }",
      });
      await waitForHydrated(settleMs);
    }

    // ── A. Capture clean high-res screenshots (1440x900) ──────────────
    if (DO_SHOTS) {
      console.log("==> Capturing fresh screenshots (1440x900)...");
      const shots: Array<{
        file: string;
        path: string;
        settleMs?: number;
        afterLoad?: () => Promise<void>;
      }> = [
        { file: "chat.png", path: `/chat/${seed.mainConvId}`, settleMs: 1200 },
        {
          file: "team.png",
          path: "/team",
          settleMs: 1000,
          afterLoad: async () => {
            // Scroll to frame all 3 multi-harness Workers (claude · pi · omp) cleanly
            await page.evaluate(() => {
              const scroller =
                document.querySelector("main") ?? document.scrollingElement ?? document.body;
              scroller.scrollTop = 620;
            });
            await Bun.sleep(350);
          },
        },
        {
          file: "workflow-execution.png",
          path: `/workflows/${seed.workflowId}`,
          settleMs: 1400,
        },
        { file: "today.png", path: "/today", settleMs: 1000 },
        { file: "requirements.png", path: `/requirements/${seed.reqId}`, settleMs: 1000 },
        { file: "wiki.png", path: "/wiki", settleMs: 1200 },
      ];

      for (const s of shots) {
        await openPage(s.path, s.settleMs ?? 900);
        if (s.afterLoad) await s.afterLoad();
        const dest = join(SHOTS_DIR, s.file);
        await page.screenshot({ path: dest, type: "png" });
        const kb = Math.round(statSync(dest).size / 1024);
        console.log(`   saved ${s.file} (${kb} KB)`);
      }
    }

    // ── B. Record ~28s main-flow video (1280x720, deterministic CDP frame capture) ──
    if (DO_VIDEO) {
      console.log("==> Recording main-flow demo video (1280x720)...");
      mkdirSync(resolve(VIDEO_OUT, ".."), { recursive: true });
      const framesDir = "/tmp/oma-demo-frames";
      rmSync(framesDir, { recursive: true, force: true });
      mkdirSync(framesDir, { recursive: true });

      await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
      await openPage("/today", 900);
      await injectDemoOverlay(page, "1/5 · Today — Personal Assistant Inbox & Pending Decisions");

      const cdp = await page.createCDPSession();
      let frameIndex = 0;
      let capturing = true;

      // Capture steady JPEG frames at ~12 fps via CDP (zero ffmpeg pipe deadlock in Bun)
      const captureLoop = (async () => {
        while (capturing) {
          const t0 = Date.now();
          try {
            const { data } = (await cdp.send("Page.captureScreenshot", {
              format: "jpeg",
              quality: 86,
            })) as { data: string };
            const name = `frame_${String(frameIndex++).padStart(5, "0")}.jpg`;
            writeFileSync(join(framesDir, name), Buffer.from(data, "base64"));
          } catch {
            // brief navigation gap — skip frame
          }
          const elapsed = Date.now() - t0;
          if (elapsed < 83) await Bun.sleep(83 - elapsed);
        }
      })();

      async function clickEl(selector: string, settleMs = 900): Promise<boolean> {
        const el = await page.$(selector);
        if (!el) return false;
        const box = await el.boundingBox();
        if (box) {
          await moveCursorTo(
            page,
            box.x + Math.min(box.width / 2, 90),
            box.y + box.height / 2,
            true,
          );
        }
        await el.click();
        await waitForHydrated(settleMs);
        return true;
      }

      try {
        // Scene 1: Today Inbox
        console.log("   [video] Scene 1/5: Today");
        await moveCursorTo(page, 380, 390);
        await Bun.sleep(2400);

        // Scene 2: Chat + Artifact Preview + Live Streaming Turn
        console.log("   [video] Scene 2/5: Chat (live streaming run)");
        if (!(await clickEl(`a[href="/chat/${seed.mainConvId}"]`, 900))) {
          await openPage(`/chat/${seed.mainConvId}`, 900);
        }
        await injectDemoOverlay(page, "2/5 · Chat — PA Dispatch, Key Diff & Artifact Preview");
        await Bun.sleep(1600);

        // Click "Preview" button on the inline Artifact card if visible
        const previewBtn = await page.evaluateHandle(() => {
          return (
            Array.from(document.querySelectorAll("button")).find(
              (b) => b.textContent?.trim() === "Preview",
            ) ?? null
          );
        });
        const previewEl = previewBtn.asElement();
        if (previewEl) {
          const box = await previewEl.boundingBox();
          if (box) {
            await moveCursorTo(page, box.x + box.width / 2, box.y + box.height / 2, true);
          }
          await previewEl.click();
          await Bun.sleep(2200);
        }

        // Type a follow-up prompt and click the send button
        const textarea = await page.$("textarea");
        if (textarea) {
          const box = await textarea.boundingBox();
          if (box) {
            await moveCursorTo(page, box.x + 140, box.y + box.height / 2, true);
          }
          await textarea.click();
          await page.keyboard.type("Confirm Delivery Gate status for agent/run_demo_coder.", {
            delay: 20,
          });
          await Bun.sleep(300);
          const sendBtn = await page.$('button[aria-label*="Send"], button[type="submit"]');
          if (sendBtn) {
            const sbox = await sendBtn.boundingBox();
            if (sbox) {
              await moveCursorTo(page, sbox.x + sbox.width / 2, sbox.y + sbox.height / 2, true);
            }
            await sendBtn.click();
          } else {
            await page.keyboard.down("Control");
            await page.keyboard.press("Enter");
            await page.keyboard.up("Control");
          }
          await Bun.sleep(3600);
        }

        // Scene 3: Requirements
        console.log("   [video] Scene 3/5: Requirements");
        if (!(await clickEl(`a[href="/requirements/${seed.reqId}"]`, 900))) {
          await clickEl('a[href="/requirements"]', 900);
          await clickEl(`a[href="/requirements/${seed.reqId}"]`, 900);
        }
        await injectDemoOverlay(
          page,
          "3/5 · Requirements — Goal, Acceptance Criteria & Verified Runs",
        );
        await moveCursorTo(page, 620, 320);
        await Bun.sleep(2800);

        // Scene 4: Team (4 Harnesses)
        console.log("   [video] Scene 4/5: Team (4 Harnesses)");
        await clickEl('a[href="/team"]', 900);
        await injectDemoOverlay(
          page,
          "4/5 · Team — One ACP Rail Across oma · Claude Code · pi · omp",
        );
        await page.evaluate(() => {
          const scroller =
            document.querySelector("main") ?? document.scrollingElement ?? document.body;
          scroller.scrollTo({ top: 620, behavior: "smooth" });
        });
        await moveCursorTo(page, 520, 440);
        await Bun.sleep(3200);

        // Scene 5: Workflow DAG
        console.log("   [video] Scene 5/5: Workflow DAG");
        await clickEl('a[href="/workflows"]', 900);
        await clickEl(`a[href="/workflows/${seed.workflowId}"]`, 1200);
        await injectDemoOverlay(
          page,
          "5/5 · Agentic Workflow DAG — Agent, Sandboxed Script & Human Gate",
        );
        await moveCursorTo(page, 760, 470);
        await Bun.sleep(3200);

        // Bonus: Git Wiki
        console.log("   [video] Bonus: Git Wiki");
        await clickEl('a[href="/wiki"]', 1100);
        await injectDemoOverlay(page, "Bonus · Git-Backed LLM Wiki — Interlinked Team Knowledge");
        await moveCursorTo(page, 640, 380);
        await Bun.sleep(2800);
      } finally {
        capturing = false;
        await captureLoop;
        console.log(`   [video] Captured ${frameIndex} frames`);
      }

      // Close Chromium BEFORE single-threaded H.264 transcoding (2-core friendly!)
      await browser.close();
      browser = null;

      console.log("==> Encoding GitHub-ready H.264 MP4 (single-threaded)...");
      execFileSync(
        FFMPEG_BIN,
        [
          "-y",
          "-framerate",
          "12",
          "-i",
          join(framesDir, "frame_%05d.jpg"),
          "-threads",
          "1",
          "-c:v",
          "libx264",
          "-preset",
          "medium",
          "-crf",
          "23",
          "-r",
          "24",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          "-an",
          VIDEO_OUT,
        ],
        { stdio: "inherit" },
      );
      rmSync(framesDir, { recursive: true, force: true });
      const mb = (statSync(VIDEO_OUT).size / (1024 * 1024)).toFixed(2);
      console.log(`==> Saved demo video: ${VIDEO_OUT} (${mb} MB)`);
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    mockServer.stop(true);
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    await Bun.sleep(400);
    for (const child of children) {
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
}

await main();
