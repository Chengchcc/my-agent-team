#!/usr/bin/env bun
/** mmt — the product CLI (raft service-cli absorption, adapted).
 *
 *  Any shell-capable harness can drive the product through plain commands:
 *  messages, reminders, tasks, saved bookmarks, room rosters. Zero MCP
 *  wiring — the CLI IS the integration artifact.
 *
 *  AUTH (deliberately NOT Raft's device-flow): Raft needs one-time grants
 *  and per-agent credential stores because it is multi-user hosted. This
 *  product is single-user local (ADR 0026): the x-auth-token IS the
 *  boundary. Fail closed — no token, no calls, no ambient fallbacks.
 *
 *  Env: MMT_URL (default http://127.0.0.1:3000), MMT_TOKEN (required).
 *  Usage: bun apps/backend/src/mmt.ts <command> …  (or `bun run mmt` here) */

const URL_BASE = process.env.MMT_URL ?? "http://127.0.0.1:3000";
const TOKEN = process.env.MMT_TOKEN;

type Json = Record<string, unknown>;

async function call(method: string, path: string, body?: Json): Promise<unknown> {
  if (!TOKEN) {
    console.error(
      "mmt: MMT_TOKEN is not set — refusing to call without credentials (fail closed).",
    );
    process.exit(2);
  }
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: { "x-auth-token": TOKEN, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = json as { error?: string } | null;
    console.error(`mmt: HTTP ${res.status} ${method} ${path}: ${err?.error ?? text.slice(0, 200)}`);
    process.exit(1);
  }
  return json;
}

export function parseArgs(argv: readonly string[]): {
  cmd: string;
  positional: string[];
  flags: Record<string, string>;
} {
  const [cmd = "", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags };
}

export async function run(argv: readonly string[]): Promise<number> {
  const { cmd, positional, flags } = parseArgs(argv);
  switch (cmd) {
    case "msg": {
      const [conversationId, ...text] = positional;
      if (!conversationId || text.length === 0) {
        console.error("usage: mmt msg <conversationId> <text...> [--to agentId]");
        return 2;
      }
      const r = (await call("POST", `/api/conversations/${conversationId}/messages`, {
        content: text.join(" "),
        ...(flags.to ? { addressedTo: [flags.to] } : {}),
      })) as { seq: number; triggeredRuns: Array<{ runId: string; agentId: string }> };
      console.log(
        `seq=${r.seq}${r.triggeredRuns.length > 0 ? ` runs=${r.triggeredRuns.map((t) => `${t.agentId}:${t.runId.slice(0, 8)}`).join(",")}` : " (ledger only — room, nobody mentioned)"}`,
      );
      return 0;
    }
    case "tasks": {
      const r = (await call("GET", "/api/tasks?limit=50")) as {
        tasks: Array<{
          status: string;
          owner: string | null;
          text: string;
          conversationId: string | null;
        }>;
      };
      const open = r.tasks.filter((t) => !["done", "closed"].includes(t.status));
      for (const t of open) {
        console.log(
          `[${t.status}] ${t.owner ?? "-"} ${t.text.slice(0, 60)} (${t.conversationId ?? "-"})`,
        );
      }
      if (open.length === 0) console.log("no open tasks");
      return 0;
    }
    case "reminders": {
      const sub = positional[0] ?? "list";
      if (sub === "list") {
        const conv = flags.conversation;
        const r = (await call(
          "GET",
          `/api/reminders${conv ? `?conversationId=${encodeURIComponent(conv)}` : ""}`,
        )) as {
          reminders: Array<{ id: string; text: string; fireAt: number; recurrence: string | null }>;
        };
        for (const rem of r.reminders) {
          console.log(
            `${rem.id.slice(0, 12)} ${rem.recurrence ? `[${rem.recurrence}]` : `[one-shot]`} ${new Date(rem.fireAt).toISOString()} ${rem.text.slice(0, 50)}`,
          );
        }
        if (r.reminders.length === 0) console.log("no pending reminders");
        return 0;
      }
      if (sub === "add") {
        const [conversationId, text, at] = [positional[1], positional[2], positional[3]];
        if (!conversationId || !text || !at) {
          console.error(
            "usage: mmt reminders add <conversationId> <text...> <epoch-ms|--in seconds> [--cron expr]",
          );
          return 2;
        }
        const fireAt = at === "--in" ? undefined : Number(at); // --in handled below
        const secs = flags.in ? Number(flags.in) : undefined;
        const when = fireAt ?? (secs !== undefined ? Date.now() + secs * 1000 : NaN);
        if (!Number.isFinite(when)) {
          console.error("mmt: need <epoch-ms> or --in <seconds>");
          return 2;
        }
        const r = (await call("POST", "/api/reminders", {
          conversationId,
          text,
          fireAt: when,
          ...(flags.cron ? { recurrence: flags.cron } : {}),
        })) as { reminder: { id: string } };
        console.log(r.reminder.id);
        return 0;
      }
      if (sub === "cancel") {
        const id = positional[1];
        if (!id) {
          console.error("usage: mmt reminders cancel <id>");
          return 2;
        }
        await call("DELETE", `/api/reminders/${id}`);
        console.log("cancelled");
        return 0;
      }
      console.error("usage: mmt reminders list|add|cancel");
      return 2;
    }
    case "saved": {
      const r = (await call("GET", "/api/saved")) as {
        saved: Array<{ seq: number; conversationId: string; text: string | null }>;
      };
      for (const s of r.saved) {
        console.log(`#${s.seq} ${s.conversationId} ${s.text?.slice(0, 60) ?? ""}`);
      }
      return 0;
    }
    case "members": {
      const conv = positional[0];
      if (!conv) {
        console.error("usage: mmt members <conversationId>");
        return 2;
      }
      const r = (await call("GET", `/api/conversations/${conv}/members`)) as { members: string[] };
      console.log(r.members.join("\n"));
      return 0;
    }
    default:
      console.error(`mmt — product CLI (raft service-cli absorption)
usage: mmt <command>
  msg <conversationId> <text...> [--to agentId]   post a message (mention routes in rooms)
  tasks                                           open task cards
  reminders list|add|cancel                       reminder management
  saved                                           bookmarked messages
  members <conversationId>                        the room's agent roster
env: MMT_URL (default http://127.0.0.1:3000), MMT_TOKEN (required)`);
      return cmd === "help" || cmd === "--help" ? 0 : 2;
  }
}

// Entry (skip when imported by tests).
if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
