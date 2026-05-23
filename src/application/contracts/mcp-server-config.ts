import { z } from 'zod'
import { createCodec } from './shared/codec'

const mcpServerConfigSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'Name must contain only alphanumeric chars, dashes, and underscores')
    .refine((s) => !s.includes('__'), 'Name must not contain "__" (reserved separator)'),
  transport: z.enum(['stdio', 'sse', 'streamable-http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
  autoStart: z.boolean().optional(),
}).refine((d) => d.transport !== 'stdio' || !!d.command, { message: 'command is required for stdio transport', path: ['command'] })
  .refine((d) => d.transport === 'stdio' || !!d.url, { message: 'url is required for sse/streamable-http transport', path: ['url'] })
  .refine((d) => d.transport === 'stdio' || (() => { try { new URL(d.url!); return true; } catch { return false; } })(), { message: 'url must be a valid URL', path: ['url'] })

/** @public — config schema input, consumed by CLI flow */
export type McpServerConfigInput = z.infer<typeof mcpServerConfigSchema>
export const mcpServerConfigCodec = createCodec(mcpServerConfigSchema)
