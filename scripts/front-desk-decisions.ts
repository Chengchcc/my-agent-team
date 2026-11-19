/** ADR 0072: what does the front desk DECIDE when the human just describes work?
 *
 *  The operator's question: "can I hand over a complex task and let it work out
 *  that it should dispatch?" That is a measurement, not a spec assertion - so
 *  this drives the REAL stack (one fresh room per utterance, no dispatch wording
 *  in the corpus) and records the outcome:
 *
 *    DISPATCH  a child conversation was opened under the room (ADR 0070)
 *    ASK       the run parked on a question (ADR 0055's slot gate)
 *    ANSWER    it replied without doing either
 *
 *  Run:  bun run scripts/front-desk-decisions.ts [--only 3] [--model id]
 *  Needs BACKEND_URL + BACKEND_AUTH_TOKEN (apps/backend/.env has them).
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The worker workspace the corpus talks about. Snapshot once, restore before
 *  each case: "already done" made three ANSWERS look wrong (2026-11-19), and a
 *  decision probe must control the state it assumes. */
const WORKER_DIR =
  process.env.WORKER_DIR ??
  join(import.meta.dir, "../apps/backend/.backend-data/agents/worker-one");
const SNAPSHOT = `${WORKER_DIR}.probe-snapshot`;

const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:3000";
const TOKEN = process.env.BACKEND_AUTH_TOKEN;
if (!TOKEN) {
  console.error("BACKEND_AUTH_TOKEN is required (apps/backend/.env)");
  process.exit(1);
}

interface Case {
  readonly id: string;
  readonly text: string;
  /** What a reasonable front desk should do; not enforced, only compared. */
  readonly expect: "DISPATCH" | "ASK" | "ANSWER";
}

const cases: readonly Case[] = JSON.parse(
  readFileSync(join(import.meta.dir, "front-desk-decisions.cases.json"), "utf-8"),
) as Case[];

const args = process.argv.slice(2);
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? Number(args[onlyIdx + 1]) : cases.length;

function resetWorkerWorkspace(): void {
  const snap = Bun.spawnSync([
    "bash",
    "-lc",
    `rm -rf '${SNAPSHOT}' && cp -a '${WORKER_DIR}' '${SNAPSHOT}'`,
  ]);
  if (snap.exitCode !== 0) throw new Error(`snapshot failed: ${snap.stderr.toString()}`);
}

function restoreWorkerWorkspace(): void {
  // cp, not rsync: rsync is not installed on the box this runs on, and a
  // missing tool must not abort the whole probe.
  const res = Bun.spawnSync([
    "bash",
    "-lc",
    `rm -rf '${WORKER_DIR}' && cp -a '${SNAPSHOT}' '${WORKER_DIR}'`,
  ]);
  if (res.exitCode !== 0) throw new Error(`restore failed: ${res.stderr.toString()}`);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-auth-token": TOKEN!,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Poll one room to a verdict.
 *
 *  A run parked on a TOOL APPROVAL is not the front desk asking the human a
 *  question: it is the permission gate (the classifier does not always agree
 *  with `auto`). This probe answers those the way an operator would - allow -
 *  so what gets measured is the INTENT, not the gate. A run parked on `ask`
 *  stops the loop: that IS the front desk deciding to ask. */
async function settle(conversationId: string): Promise<string> {
  const deadline = Date.now() + 240_000;
  let last = "unknown";
  while (Date.now() < deadline) {
    const { runs } = await api<{ runs: RunRow[] }>(
      `/api/agent-runs?conversationId=${encodeURIComponent(conversationId)}`,
    );
    last = runs[0]?.status ?? "none";
    if (last === "completed" || last === "failed" || last === "aborted" || last === "waiting") {
      if (last !== "waiting") return last;
      const pending = await api<{ actions?: PendingAction[] }>("/api/pending-actions").catch(
        () => ({ actions: [] as PendingAction[] }),
      );
      const mine = (pending.actions ?? []).filter(
        (a) => a.runId === runs[0]?.runId && a.status === "pending",
      );
      if (mine.length === 0) {
        // The run turns `waiting` a beat before its action row lands; giving up
        // immediately recorded "parked" for a run the operator would have
        // approved (observed 2026-11-19).
        await Bun.sleep(2000);
        continue;
      }
      if (mine.some((a) => a.kind === "ask")) return "waiting";
      const approval = mine.find((a) => a.kind === "approval");
      if (approval) {
        const callId = approval.payload?.callId;
        if (typeof callId === "string") {
          await fetch(`${BACKEND}/api/agent-runs/${approval.runId}/approval`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-auth-token": TOKEN! },
            body: JSON.stringify({ callId, decision: "allow_always" }),
          }).catch(() => {});
        }
        await Bun.sleep(2000);
        continue;
      }
      return "waiting";
    }
    await Bun.sleep(2000);
  }
  return last;
}

interface PendingAction {
  runId: string;
  kind: string;
  status: string;
  payload?: { callId?: unknown };
}

/** The endpoint's row, as far as this probe reads it (the fields are declared,
 *  not assumed: a cast here would trust a shape nothing checked). */
interface RunRow {
  runId: string;
  status: string;
  parentRunId?: string | null;
}

/** The agent's last prose, straight from the ledger: a MISS is only useful with
 *  the sentence that made it one, and the REST surface does not serve the
 *  ledger (AHP does). This probe runs on the same box as the data dir. */
function lastAssistantText(conversationId: string): string {
  const dbPath = join(WORKER_DIR, "../../backend.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query(
        `SELECT content FROM conversation_ledger
         WHERE conversation_id = ? AND content LIKE '%"role":"assistant"%'
           AND content NOT LIKE '%"text":""%'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(conversationId) as { content?: string } | undefined;
    if (!row?.content) return "";
    const parsed: unknown = JSON.parse(row.content);
    if (typeof parsed !== "object" || parsed === null || !("text" in parsed)) return "";
    const text = parsed.text;
    return typeof text === "string" ? text : "";
  } finally {
    db.close();
  }
}

interface Outcome {
  verdict: "DISPATCH" | "ASK" | "ANSWER";
  detail: string;
}

/** DISPATCH = a run in this room carries a parent (ADR 0051/0070: the dispatch
 *  opened a room and the worker's run names it); ASK = parked; else ANSWER. */
async function classify(conversationId: string): Promise<Outcome> {
  const { runs } = await api<{ runs: RunRow[] }>(
    `/api/agent-runs?conversationId=${encodeURIComponent(conversationId)}`,
  );
  const paused = runs.find((r) => r.status === "waiting");
  if (paused) return { verdict: "ASK", detail: `run ${paused.runId.slice(0, 8)} is waiting` };
  const child = runs.find((r) => typeof r.parentRunId === "string" && r.parentRunId !== "");
  if (child) return { verdict: "DISPATCH", detail: `child run ${child.runId.slice(0, 8)}` };
  return { verdict: "ANSWER", detail: `run ${runs[0]?.runId.slice(0, 8) ?? "-"}` };
}

const results: Array<{ c: Case; got: Outcome; ok: boolean; reply: string }> = [];
resetWorkerWorkspace();
console.log(`worker workspace snapshot: ${SNAPSHOT}\n`);

// A unique name per case: the worker's room accumulates real work, so a case
// that says "add greet" is answered with "already exists" - correctly, and
// uselessly for measuring the DECISION. Cases write `{{fn}}`.
const suffix = Math.random().toString(36).slice(2, 6);
const withName = (text: string) => text.replaceAll("{{fn}}", `fn_${suffix}`);

for (const raw of cases.slice(0, only)) {
  const c: Case = { ...raw, text: withName(raw.text) };
  // Every case starts from the snapshot: "the work already exists" must never
  // be the reason a dispatch did not happen.
  restoreWorkerWorkspace();
  const room = await api<{ conversationId: string }>("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ agentId: "default" }),
  });
  await api(`/api/conversations/${room.conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: c.text }),
  });
  const status = await settle(room.conversationId);
  const got =
    status === "waiting"
      ? { verdict: "ASK" as const, detail: "parked" }
      : await classify(room.conversationId);
  const ok = got.verdict === c.expect;
  const reply = lastAssistantText(room.conversationId);
  results.push({ c, got, ok, reply });
  console.log(
    `${ok ? "ok  " : "MISS"} ${c.id.padEnd(18)} expect=${c.expect.padEnd(8)} got=${got.verdict.padEnd(8)} (${got.detail})`,
  );
  if (!ok) console.log(`     reply: ${reply.replace(/\s+/g, " ").slice(0, 200)}`);
  // Keep the room unless asked to clean: the transcript IS the evidence for a
  // MISS, and deleting it on the way out destroyed exactly that (2026-11-19).
  if (args.includes("--clean")) {
    await fetch(`${BACKEND}/api/conversations/${room.conversationId}`, {
      method: "DELETE",
      headers: { "x-auth-token": TOKEN },
    }).catch(() => {});
  } else {
    console.log(`     room: ${room.conversationId}`);
  }
}

const hits = results.filter((r) => r.ok).length;
console.log(`\n${hits}/${results.length} matched the expectation`);
await Bun.write(
  join(import.meta.dir, "front-desk-decisions.report.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      backend: BACKEND,
      hits,
      total: results.length,
      results: results.map((r) => ({
        id: r.c.id,
        expect: r.c.expect,
        got: r.got.verdict,
        detail: r.got.detail,
        reply: r.reply.slice(0, 400),
      })),
    },
    null,
    2,
  ),
);
console.log("report: scripts/front-desk-decisions.report.json");
