/** Tool schema artifact: bundles JSON Schema for LLM registration
 *  + parser for runtime arg validation. No zod leakage past contracts/. */
export interface ToolSchemaArtifact<T = Record<string, unknown>> {
  /** JSON Schema fragment for LLM tool.parameters field. */
  jsonSchema: Record<string, unknown>
  /** Throws on invalid input; returns typed value on success. */
  parse(raw: Record<string, unknown>): T
  /** Branded marker so misuse at call sites is type-checkable. */
  readonly __kind: 'tool-schema-artifact'
}
