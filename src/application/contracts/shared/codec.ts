import type { z } from 'zod';

/**
 * Result of safeDecode — discriminated union so callers can narrow
 * without catching exceptions.
 */
export type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Create a symmetric encode/decode pair from a zod schema.
 * - `encode` never fails (zod .parse throws if schema violated, which indicates a code bug)
 * - `decode` returns null on any failure (malformed input, wrong shape, etc.)
 * - `safeDecode` returns a discriminated result for fail-soft callers.
 */
export function createCodec<T>(schema: z.ZodType<T>) {
  return {
    encode(value: T): unknown {
      return schema.parse(value) as unknown;
    },
    decode(raw: unknown): T | null {
      const result = schema.safeParse(raw);
      return result.success ? result.data : null;
    },
    safeDecode(raw: unknown): DecodeResult<T> {
      const result = schema.safeParse(raw);
      return result.success
        ? { ok: true, value: result.data }
        : { ok: false, error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    },
  };
}
