import type { Database } from "bun:sqlite";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { ProposalRow } from "./domain.js";
import type { ProposalPort } from "./ports.js";

export function sqliteProposalAdapter(db: Database): ProposalPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    insert(row) {
      d.insert(schema.proposal)
        .values({ ...row, status: "pending", resolvedAt: null })
        .run();
    },

    listPending(kind?: string): ProposalRow[] {
      const where =
        kind === undefined
          ? eq(schema.proposal.status, "pending")
          : and(eq(schema.proposal.kind, kind), eq(schema.proposal.status, "pending"));
      return d
        .select()
        .from(schema.proposal)
        .where(where)
        .orderBy(desc(schema.proposal.createdAt))
        .limit(200)
        .all();
    },

    latestPending(kind, targetId): ProposalRow | null {
      return (
        d
          .select()
          .from(schema.proposal)
          .where(
            and(
              eq(schema.proposal.kind, kind),
              eq(schema.proposal.targetId, targetId),
              eq(schema.proposal.status, "pending"),
            ),
          )
          .orderBy(desc(schema.proposal.createdAt))
          .get() ?? null
      );
    },

    resolve(id, status, resolvedAt, payload) {
      // Read first, then write: SQLite here is one writer in one process, and the read is what
      // answers "was this still pending" — bun-sqlite's run() reports no affected rows.
      const pending = d
        .select()
        .from(schema.proposal)
        .where(and(eq(schema.proposal.id, id), eq(schema.proposal.status, "pending")))
        .get();
      if (!pending) return false;
      const resolved = { status, resolvedAt };
      const applied = payload === undefined ? resolved : { ...resolved, payload };
      d.update(schema.proposal).set(applied).where(eq(schema.proposal.id, id)).run();
      return true;
    },
  };
}
