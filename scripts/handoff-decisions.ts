/** ADR 0075/0076: does the front desk ORCHESTRATE — fan out in parallel, and
 *  chain one worker's result into the next worker's brief?
 *
 *  The decision probe (front-desk-decisions.ts) answers "dispatch or answer".
 *  This one answers the harder question: once it dispatches, can it run a
 *  CHAIN — research first, implementation after, with the research's artifact
 *  actually riding into the second brief instead of a paraphrase of it.
 *
 *  Evidence is read from the store, not from prose: child rooms in creation
 *  order (who, when), and each child's first message (the XML brief, where
 *  `<references>` / `artifacts://` would appear).
 *
 *  Run: bun run scripts/handoff-decisions.ts [--scenario chain|fanout] [--timeout 480]
 *  Needs BACKEND_URL + BACKEND_AUTH_TOKEN (apps/backend/.env has them).
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:3000";
const TOKEN = process.env.BACKEND_AUTH_TOKEN;
if (!TOKEN) {
  console.error("BACKEND_AUTH_TOKEN is required (apps/backend/.env)");
  process.exit(1);
}
const DB = join(import.meta.dir, "../apps/backend/.backend-data/backend.db");

const args = process.argv.slice(2);
const scenario = (args[args.indexOf("--scenario") + 1] ?? "chain") as "chain" | "fanout";
const timeoutSec = Number(args[args.indexOf("--timeout") + 1] ?? "480");

const MESSAGES: Record<"chain" | "fanout", string> = {
  chain:
    "帮我改一下 my-agent-team 的 README 首屏：先调研清楚同类项目首屏都怎么写（要有依据），" +
    "再照着结论动手改，改完跑测试。研究和实现可以分给不同的人，但结论必须落到实际改动上。",
  fanout:
    "两件事并行做，做完一起告诉我：1) 调研 my-agent-team 的 README 首屏该怎么写（只出结论）；" +
    "2) 修一下 worker-one 里 greet 空名字会输出畸形字符串的 bug，配一条测试。",
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-auth-token": TOKEN,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

const db = new Database(DB, { readonly: true });

type Child = { conversationId: string; agentId: string; createdAt: number; firstMessage: string };

function childrenOf(parent: string): Child[] {
  const rows = db
    .query(
      `SELECT conversation_id AS conversationId, agent_id AS agentId, created_at AS createdAt
         FROM conversation WHERE parent_conversation_id = ? ORDER BY created_at ASC`,
    )
    .all(parent) as Array<{ conversationId: string; agentId: string; createdAt: number }>;
  return rows.map((row) => {
    const first = db
      .query(
        `SELECT content FROM conversation_ledger WHERE conversation_id = ? ORDER BY seq ASC LIMIT 1`,
      )
      .get(row.conversationId) as { content: string } | null;
    let text = "";
    if (first !== null) {
      // Boundary narrowing, not an assertion: the ledger row is JSON we wrote,
      // but a malformed row must degrade to "" instead of throwing here.
      const parsed: unknown = JSON.parse(first.content);
      // The ledger row carries the words under `text` (agent-ledger shape);
      // older rows used `content`. Read both, without asserting a shape.
      if (typeof parsed === "object" && parsed !== null) {
        if ("text" in parsed && typeof parsed.text === "string") {
          text = parsed.text;
        } else if ("content" in parsed && typeof parsed.content === "string") {
          text = parsed.content;
        }
      }
    }
    return { ...row, firstMessage: text };
  });
}

function runStatuses(conversationId: string): string[] {
  const rows = db
    .query(`SELECT status FROM agent_run WHERE conversation_id = ? ORDER BY created_at ASC`)
    .all(conversationId) as Array<{ status: string }>;
  return rows.map((r) => r.status);
}

const started = Date.now();
const room = await api<{ conversationId: string }>("/api/conversations", {
  method: "POST",
  body: JSON.stringify({ agentId: "default" }),
});
console.log(`scenario=${scenario} room=${room.conversationId}\n`);
await api(`/api/conversations/${room.conversationId}/messages`, {
  method: "POST",
  body: JSON.stringify({ content: MESSAGES[scenario] }),
});

const deadline = started + timeoutSec * 1000;
let kids: Child[] = [];
let settled = false;
const TERMINAL = ["completed", "failed", "aborted", "timeout"];
while (Date.now() < deadline) {
  kids = childrenOf(room.conversationId);
  const roomRuns = runStatuses(room.conversationId);
  const waiting = roomRuns.includes("waiting") || roomRuns.includes("running");
  const kidsDone = kids.every((k) => {
    const statuses = runStatuses(k.conversationId);
    return statuses.length > 0 && statuses.every((s) => TERMINAL.includes(s));
  });
  // Chain needs a SECOND wave after the first worker returns: keep waiting while
  // the room is still producing runs, stop when everything is terminal and no
  // new child appeared for a while.
  if (kids.length >= 2 && kidsDone && !waiting) {
    settled = true;
    break;
  }
  if (kids.length >= 1 && kidsDone && !waiting) {
    // give the front desk a chance to chain the result onward
    await Bun.sleep(90_000);
    kids = childrenOf(room.conversationId);
    if (kids.length >= 2) settled = true;
    break;
  }
  await Bun.sleep(10_000);
}

const finalKids = childrenOf(room.conversationId);
const report = {
  scenario,
  room: room.conversationId,
  settled,
  elapsedSec: Math.round((Date.now() - started) / 1000),
  children: finalKids.map((k) => ({
    agentId: k.agentId,
    atSec: Math.round((k.createdAt - started) / 1000),
    artifactRef: /artifacts:\/\/[^\s"<>]+/.exec(k.firstMessage)?.[0] ?? null,
    wikiRef: /wiki:[^\s"<>]+/.exec(k.firstMessage)?.[0] ?? null,
    task: /<task [^>]*>/.exec(k.firstMessage)?.[0] ?? null,
  })),
  agents: [...new Set(finalKids.map((k) => k.agentId))],
  runStatuses: Object.fromEntries(finalKids.map((k) => [k.agentId, runStatuses(k.conversationId)])),
};

console.log(JSON.stringify(report, null, 2));
await Bun.write(
  join(import.meta.dir, "handoff-decisions.report.json"),
  JSON.stringify(report, null, 2),
);
db.close();
