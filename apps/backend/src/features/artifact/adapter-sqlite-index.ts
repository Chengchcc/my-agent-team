import type { Database } from "bun:sqlite";
import { and, desc, eq, like, or, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { artifact } from "../../infra/db/schema.js";
import type { EntityLabelResolver } from "../../infra/entity-labels.js";
import type {
  ArtifactListFilter,
  ArtifactMeta,
  ArtifactSource,
  ArtifactUploadInput,
} from "./domain.js";
import type { ArtifactPort } from "./ports.js";

function compactSource(source: ArtifactSource): ArtifactSource | undefined {
  const out: ArtifactSource = {};
  if (source.runId) out.runId = source.runId;
  if (source.conversationId) out.conversationId = source.conversationId;
  if (source.requirementId) out.requirementId = source.requirementId;
  if (source.workflowExecutionId) out.workflowExecutionId = source.workflowExecutionId;
  if (source.agentId) out.agentId = source.agentId;
  if (source.projectId) out.projectId = source.projectId;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** ADR 0082 D1: wraps the disk ArtifactPort with a SQLite metadata & provenance
 *  index. Bytes live on disk; SQLite answers list/filter/meta queries and
 *  enriches rows with human-readable entity labels. */
export function createSqliteArtifactIndexAdapter(deps: {
  inner: ArtifactPort;
  db: Database;
  labelResolver?: EntityLabelResolver;
}): ArtifactPort {
  const { inner, db, labelResolver } = deps;
  const d = drizzle(db, { schema: { artifact }, casing: "snake_case" });

  function existsIn(table: string, col: string, value: string | undefined): string | null {
    if (!value) return null;
    const row = db.query(`SELECT 1 FROM ${table} WHERE ${col} = ? LIMIT 1`).get(value);
    return row ? value : null;
  }

  /** Freeze causal provenance at write time (ADR 0082 D1):
   *  explicit fields win; missing requirement/project/execution/agent/conversation
   *  are inherited from agent_run, workflow_node_run, workflow_execution, or conversation. */
  function enrichSource(input?: ArtifactSource): ArtifactSource | undefined {
    if (!input) return undefined;
    const out: ArtifactSource = { ...input };

    if (out.runId) {
      const runRow = db
        .query(
          "SELECT conversation_id, agent_id, requirement_id FROM agent_run WHERE run_id = ? LIMIT 1",
        )
        .get(out.runId) as {
        conversation_id: string | null;
        agent_id: string | null;
        requirement_id: string | null;
      } | null;
      if (runRow) {
        if (!out.conversationId && runRow.conversation_id)
          out.conversationId = runRow.conversation_id;
        if (!out.agentId && runRow.agent_id) out.agentId = runRow.agent_id;
        if (!out.requirementId && runRow.requirement_id) out.requirementId = runRow.requirement_id;
      }
      if (!out.workflowExecutionId) {
        const nodeRow = db
          .query("SELECT execution_id FROM workflow_node_run WHERE run_id = ? LIMIT 1")
          .get(out.runId) as { execution_id: string } | null;
        if (nodeRow) out.workflowExecutionId = nodeRow.execution_id;
      }
    }

    if (out.workflowExecutionId) {
      const execRow = db
        .query(
          "SELECT requirement_id, conversation_id, project_id FROM workflow_execution WHERE execution_id = ? LIMIT 1",
        )
        .get(out.workflowExecutionId) as {
        requirement_id: string | null;
        conversation_id: string | null;
        project_id: string | null;
      } | null;
      if (execRow) {
        if (!out.requirementId && execRow.requirement_id)
          out.requirementId = execRow.requirement_id;
        if (!out.conversationId && execRow.conversation_id)
          out.conversationId = execRow.conversation_id;
        if (!out.projectId && execRow.project_id) out.projectId = execRow.project_id;
      }
    }

    if (out.conversationId) {
      const convRow = db
        .query(
          "SELECT agent_id, current_requirement_id, project_id FROM conversation WHERE conversation_id = ? LIMIT 1",
        )
        .get(out.conversationId) as {
        agent_id: string | null;
        current_requirement_id: string | null;
        project_id: string | null;
      } | null;
      if (convRow) {
        if (!out.agentId && convRow.agent_id) out.agentId = convRow.agent_id;
        if (!out.requirementId && convRow.current_requirement_id)
          out.requirementId = convRow.current_requirement_id;
        if (!out.projectId && convRow.project_id) out.projectId = convRow.project_id;
      }
    }

    if (out.requirementId && !out.projectId) {
      const reqRow = db
        .query("SELECT project_id FROM requirement WHERE requirement_id = ? LIMIT 1")
        .get(out.requirementId) as { project_id: string | null } | null;
      if (reqRow?.project_id) out.projectId = reqRow.project_id;
    }

    return compactSource(out);
  }

  function upsertRow(meta: ArtifactMeta, source: ArtifactSource | undefined): void {
    const now = meta.updatedAt || Date.now();
    // Nullable FK columns only store values whose parent row exists in SQLite
    // (preserves ON DELETE SET NULL referential integrity without rejecting
    // synthetic or historical IDs in disk sidecars).
    const values = {
      url: meta.url,
      folder: meta.folder,
      filename: meta.filename,
      size: meta.size,
      mimeType: meta.mimeType,
      encoding: meta.encoding,
      sha256: meta.sha256 ?? null,
      runId: existsIn("agent_run", "run_id", source?.runId),
      conversationId: existsIn("conversation", "conversation_id", source?.conversationId),
      requirementId: existsIn("requirement", "requirement_id", source?.requirementId),
      workflowExecutionId: existsIn(
        "workflow_execution",
        "execution_id",
        source?.workflowExecutionId,
      ),
      agentId: source?.agentId ?? null,
      projectId: existsIn("project", "project_id", source?.projectId),
      createdAt: now,
      updatedAt: now,
    };
    d.insert(artifact)
      .values(values)
      .onConflictDoUpdate({
        target: artifact.url,
        set: {
          folder: values.folder,
          filename: values.filename,
          size: values.size,
          mimeType: values.mimeType,
          encoding: values.encoding,
          sha256: values.sha256,
          runId: values.runId,
          conversationId: values.conversationId,
          requirementId: values.requirementId,
          workflowExecutionId: values.workflowExecutionId,
          agentId: values.agentId,
          projectId: values.projectId,
          updatedAt: values.updatedAt,
        },
      })
      .run();
  }

  function rowsToMetas(rows: Array<typeof artifact.$inferSelect>): ArtifactMeta[] {
    // Resolve workflowId for rows tied to a workflow execution so workflowName labels work too.
    const execIds = rows
      .map((r) => r.workflowExecutionId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const workflowIdByExec = new Map<string, string>();
    if (execIds.length > 0) {
      const unique = [...new Set(execIds)];
      for (let i = 0; i < unique.length; i += 500) {
        const chunk = unique.slice(i, i + 500);
        const qs = chunk.map(() => "?").join(", ");
        const execRows = db
          .query(
            `SELECT execution_id, workflow_id FROM workflow_execution WHERE execution_id IN (${qs})`,
          )
          .all(...chunk) as Array<{ execution_id: string; workflow_id: string }>;
        for (const er of execRows) workflowIdByExec.set(er.execution_id, er.workflow_id);
      }
    }

    const maps = labelResolver?.resolveBatch({
      agentIds: rows.map((r) => r.agentId),
      conversationIds: rows.map((r) => r.conversationId),
      requirementIds: rows.map((r) => r.requirementId),
      projectIds: rows.map((r) => r.projectId),
      workflowIds: [...workflowIdByExec.values()],
    });

    return rows.map((r) => {
      const source = compactSource({
        runId: r.runId ?? undefined,
        conversationId: r.conversationId ?? undefined,
        requirementId: r.requirementId ?? undefined,
        workflowExecutionId: r.workflowExecutionId ?? undefined,
        agentId: r.agentId ?? undefined,
        projectId: r.projectId ?? undefined,
      });
      const workflowId = r.workflowExecutionId
        ? workflowIdByExec.get(r.workflowExecutionId)
        : undefined;
      const labels = labelResolver?.labelsFor(
        {
          agentId: r.agentId,
          conversationId: r.conversationId,
          requirementId: r.requirementId,
          projectId: r.projectId,
          workflowId,
        },
        maps,
      );
      return {
        url: r.url,
        folder: r.folder,
        filename: r.filename,
        size: r.size,
        mimeType: r.mimeType,
        encoding: r.encoding === "base64" ? "base64" : "utf8",
        updatedAt: r.updatedAt,
        ...(r.sha256 ? { sha256: r.sha256 } : {}),
        ...(source ? { source } : {}),
        ...(labels ? { labels } : {}),
      };
    });
  }

  return {
    async put(input: ArtifactUploadInput) {
      const enriched = enrichSource(input.source);
      const meta = await inner.put({ ...input, source: enriched });
      upsertRow(meta, enriched);
      const labels = labelResolver?.labelsFor({
        agentId: enriched?.agentId,
        conversationId: enriched?.conversationId,
        requirementId: enriched?.requirementId,
        projectId: enriched?.projectId,
      });
      return { ...meta, ...(labels ? { labels } : {}) };
    },
    async get(ref) {
      return inner.get(ref);
    },
    async list(filter) {
      const parsed: ArtifactListFilter =
        typeof filter === "string" ? { folder: filter } : (filter ?? {});
      const conds: SQL[] = [];
      if (parsed.folder) {
        const clean = parsed.folder.replace(/^\/+|\/+$/g, "");
        if (clean.includes("..")) throw new Error("artifact path escapes root");
        const folderCond = or(eq(artifact.folder, clean), like(artifact.folder, `${clean}/%`));
        if (folderCond) conds.push(folderCond);
      }
      if (parsed.requirementId) conds.push(eq(artifact.requirementId, parsed.requirementId));
      if (parsed.conversationId) conds.push(eq(artifact.conversationId, parsed.conversationId));
      if (parsed.workflowExecutionId)
        conds.push(eq(artifact.workflowExecutionId, parsed.workflowExecutionId));
      if (parsed.agentId) conds.push(eq(artifact.agentId, parsed.agentId));
      if (parsed.projectId) conds.push(eq(artifact.projectId, parsed.projectId));
      if (parsed.runId) conds.push(eq(artifact.runId, parsed.runId));

      const rows =
        conds.length > 0
          ? await d
              .select()
              .from(artifact)
              .where(and(...conds))
              .orderBy(desc(artifact.updatedAt))
          : await d.select().from(artifact).orderBy(desc(artifact.updatedAt));
      return rowsToMetas(rows);
    },
    async getMeta(url) {
      const rows = await d.select().from(artifact).where(eq(artifact.url, url)).limit(1);
      if (rows.length > 0) return rowsToMetas(rows)[0] ?? null;
      const fromDisk = await inner.getMeta?.(url);
      if (!fromDisk) return null;
      const enriched = enrichSource(fromDisk.source);
      upsertRow(fromDisk, enriched);
      const refreshed = await d.select().from(artifact).where(eq(artifact.url, url)).limit(1);
      return refreshed.length > 0 ? (rowsToMetas(refreshed)[0] ?? null) : fromDisk;
    },
    async delete(url) {
      const ok = await inner.delete(url);
      await d.delete(artifact).where(eq(artifact.url, url));
      return ok;
    },
    async exists(url) {
      return inner.exists(url);
    },
    async verify(url) {
      return inner.verify(url);
    },
    async backfill() {
      const onDisk = await inner.list();
      const existing = new Set(
        (db.query("SELECT url FROM artifact").all() as Array<{ url: string }>).map((r) => r.url),
      );
      let added = 0;
      for (const meta of onDisk) {
        if (existing.has(meta.url)) continue;
        const enriched = enrichSource(meta.source);
        upsertRow(meta, enriched);
        added += 1;
      }
      return added;
    },
  };
}
