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

/** What one of a run's input fields takes. */
export type InputKind = "string" | "number" | "boolean" | "artifact";

/** The input of a run as the dialog sends it. */
export interface RunInput {
  input: Record<string, unknown>;
  /** The artifact fields' addresses, which the server also expects beside the input. */
  artifacts: string[];
}

/** What a run's input field takes, from the definition's hint for it. */
export function inputKindOf(type: unknown): InputKind {
  if (type === "artifact") {
    return "artifact";
  }
  return paramHintOf(type);
}

/** The input of a run from what the person typed into the dialog's fields. An empty field is
 *  left out, so the definition's own default applies; a number field holds a number and a
 *  boolean field holds `true` or `false`, not the words. */
export function runInput(
  params: ReadonlyArray<{ key: string; type: unknown }>,
  values: Readonly<Record<string, string>>,
): RunInput {
  const input: Record<string, unknown> = {};
  const artifacts: string[] = [];
  for (const param of params) {
    const raw = values[param.key] ?? "";
    if (raw === "") {
      continue;
    }
    const kind = inputKindOf(param.type);
    if (kind === "number") {
      input[param.key] = Number(raw);
    } else if (kind === "boolean") {
      input[param.key] = raw === "true";
    } else {
      input[param.key] = raw;
    }
    if (kind === "artifact") {
      artifacts.push(raw);
    }
  }
  return { input, artifacts };
}

/** The lines that tell the PA which workflow a request is about. The editor's "Draft a request"
 *  puts them into the composer once, with the request after them. It is a message to the model,
 *  so it is English in every UI language. */
export function workflowRequest(workflowId: string, goal: string, skillCommand: string): string {
  const skill = skillCommand === "" ? "" : `${skillCommand}\n`;
  const context = [
    "<workflow-context>",
    `<workflowId>${workflowId}</workflowId>`,
    `<goal>${goal}</goal>`,
    "</workflow-context>",
  ].join("\n");
  const how =
    "Read this workflow with workflow_read first. Send a changed definition with workflow_write: it reaches me as an unsaved draft, and nothing is saved until I save it.";
  return `${skill}${context}\n\n${how}\n\nMy request: `;
}

/** The request the new-workflow sheet puts into the composer: the workflow is not created yet, so
 *  it asks for advice and says so. English in every UI language, like every message to the model. */
export function newWorkflowRequest(
  name: string,
  description: string,
  skillCommand: string,
): string {
  const skill = skillCommand === "" ? "" : `${skillCommand}\n`;
  const trimmed = description.trim();
  const purpose = trimmed === "" ? "" : `\nWhat it is for: ${trimmed}`;
  const ask =
    "Suggest the steps it needs and where a person must decide. Nothing is created by this message: I create the draft myself and ask for changes in its editor.";
  return `${skill}I am about to create a workflow named "${name}".${purpose}\n${ask}\n\nMy request: `;
}
