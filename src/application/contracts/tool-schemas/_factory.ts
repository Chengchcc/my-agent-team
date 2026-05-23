import { z } from 'zod'
import type { ToolSchemaArtifact } from './_artifact'

function zodFieldToJson(schema: z.ZodTypeAny): Record<string, unknown> {
  let inner = schema
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodNullable ||
    inner instanceof z.ZodDefault
  ) {
    inner = inner._def.innerType
  }

  if (inner instanceof z.ZodString) return { type: 'string', ...(inner.description ? { description: inner.description } : {}) }
  if (inner instanceof z.ZodNumber) return { type: 'number', ...(inner.description ? { description: inner.description } : {}) }
  if (inner instanceof z.ZodBoolean) return { type: 'boolean', ...(inner.description ? { description: inner.description } : {}) }
  if (inner instanceof z.ZodEnum) return { type: 'string', enum: inner.options, ...(inner.description ? { description: inner.description } : {}) }
  if (inner instanceof z.ZodArray) {
    return { type: 'array', items: zodFieldToJson(inner.element), ...(inner.description ? { description: inner.description } : {}) }
  }
  if (inner instanceof z.ZodObject) {
    return zodToJsonSchema(inner as z.ZodObject<z.ZodRawShape>)
  }
  return { type: 'string' }
}

function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, value] of Object.entries(schema.shape)) {
    const zodSchema = value as z.ZodTypeAny
    properties[key] = zodFieldToJson(zodSchema)

    let current: z.ZodTypeAny = zodSchema
    let isOptional = false
    while (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
        isOptional = true
      }
      current = current._def.innerType
    }
    if (!isOptional) {
      required.push(key)
    }
  }

  const result: Record<string, unknown> = { type: 'object', properties }
  if (required.length > 0) result.required = required
  return result
}

function buildParser<T>(schema: z.ZodType<T>) {
  return (raw: Record<string, unknown>): T => {
    const result = schema.safeParse(raw)
    if (!result.success) {
      const errors = result.error.issues
        .map(i => `- ${i.path.join('.')}: ${i.message}`).join('\n')
      throw new Error(`Parameter validation failed:\n${errors}`)
    }
    return result.data
  }
}

export function makeToolSchema<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
): ToolSchemaArtifact<z.infer<T>> {
  return {
    jsonSchema: zodToJsonSchema(schema),
    parse: buildParser(schema) as (raw: Record<string, unknown>) => z.infer<T>,
    __kind: 'tool-schema-artifact',
  }
}
