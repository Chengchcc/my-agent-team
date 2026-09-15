import type { PluginTool } from "../runtime/plugin.js";
import { validateJsonSchema } from "./results.js";

/** Structured-output tool for a schema-bearing subagent (omp's `yield`).
 *
 *  The schema becomes the TOOL's inputSchema, so the provider parses the
 *  payload as tool arguments and the parent never re-parses model prose. That
 *  is the whole point: a real 7-agent fan-out lost 5 subagents because the
 *  child wrote its JSON inside a markdown fence and the parent's
 *  `JSON.parse(text)` rejected it. Tool arguments have no fence problem.
 *
 *  Returning `terminate` ends the child's loop in the same turn, so the
 *  payload is also its last act (omp's run completes on yield). */
export function createYieldTool(
  schema: Readonly<Record<string, unknown>>,
  capture: (payload: unknown) => void,
): PluginTool {
  return {
    name: "yield",
    description:
      "Return the assignment's result to your caller. Call this ONCE, when the work is done: " +
      "the arguments ARE the structured output the caller requires. Do not also write the " +
      "JSON in your final message.",
    executionMode: "serial",
    inputSchema: schema,
    async execute(args) {
      // Validate before accepting: a rejected yield leaves the child running so
      // it can fix the payload, instead of the parent failing the agent later.
      const violation = validateJsonSchema(args, schema);
      if (violation) {
        return {
          content: `yield rejected: ${violation}. Fix the payload and call yield again.`,
          isError: true,
        };
      }
      capture(args);
      return { content: "result recorded", terminate: true };
    },
  };
}
