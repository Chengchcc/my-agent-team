import type { WorkflowDefinition, WorkflowMeta } from "@chengchenccc/workflow";

/** A workflow parameter's type word, from either shape the definition uses: a bare word, or a
 *  schema object whose `type` may be a list. */
export function paramHintOf(schema: unknown): "string" | "number" | "boolean" {
  if (typeof schema === "string") {
    if (schema === "number" || schema === "integer") return "number";
    if (schema === "boolean") return "boolean";
    return "string";
  }
  if (typeof schema === "object" && schema !== null && "type" in schema) {
    const types = schema.type;
    const first = Array.isArray(types) ? types[0] : types;
    if (first === "number" || first === "integer") return "number";
    if (first === "boolean") return "boolean";
  }
  return "string";
}

/** Kebab-case id from a display name. The workflow id is written to `workflows/<id>.workflow.json`
 *  and appears in the editor title, the chat `<workflow-context>` the agent reads, and the run
 *  URLs, so it must be a readable slug, not a random token. */
export function slugifyWorkflowId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** The smallest valid definition: a start, an end, and the line between them. */
export function blankWorkflow(id: string, name: string, description: string): WorkflowDefinition {
  const meta: WorkflowMeta = { name, status: "draft" };
  if (description.trim() !== "") meta.description = description.trim();
  return {
    version: 1,
    id,
    meta,
    nodes: [
      { id: "start", type: "start" },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [{ from: "start", to: "done" }],
  };
}

/** A copy of a saved definition under a new id. The graph travels; the schedule does not: a copy
 *  never comes with an enabled trigger, and run history belongs to the original. */
export function copyWorkflowDefinition(
  source: WorkflowDefinition,
  id: string,
  name: string,
): WorkflowDefinition {
  return { ...source, id, triggers: [], meta: { ...source.meta, name, status: "draft" } };
}
