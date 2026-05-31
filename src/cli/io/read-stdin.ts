import { Errors } from '../errors/cli-error'

const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 50
const MAX_STDIN_BYTES = 10 * 1024 * 1024 // 10MB

/**
 * Read stdin if it's a pipe (not a TTY).
 *
 * Uses a first-byte timeout to distinguish "pipe feeding data" from "pipe hung open"
 * (e.g. SSH passthrough, Docker exec). If no data arrives within firstByteTimeoutMs,
 * returns empty string. Once the first byte arrives, reads to EOF with no timeout.
 *
 * Total size capped at maxBytes (10MB default).
 */
export async function readStdinIfPiped(
  opts: { firstByteTimeoutMs?: number; maxBytes?: number } = {},
): Promise<string> {
  if (process.stdin.isTTY) return ''

  const firstByteMs = opts.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? MAX_STDIN_BYTES

  // Phase 1: race for first byte
  const firstByte = await Promise.race([
    new Promise<Buffer | null>((resolve) => {
      const onData = (chunk: Buffer) => {
        process.stdin.off('data', onData)
        process.stdin.off('end', onEnd)
        resolve(chunk)
      }
      const onEnd = () => {
        process.stdin.off('data', onData)
        process.stdin.off('end', onEnd)
        resolve(null)
      }
      process.stdin.on('data', onData)
      process.stdin.on('end', onEnd)
    }),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), firstByteMs)),
  ])

  if (firstByte === undefined) {
    process.stdin.pause()
    return ''
  }
  if (firstByte === null) return ''

  // Phase 2: read to EOF, no timeout, with size cap
  const chunks: Buffer[] = [firstByte]
  let total = firstByte.byteLength
  return new Promise<string>((resolve, reject) => {
    process.stdin.on('data', (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > maxBytes) {
        process.stdin.pause()
        reject(Errors.stdinTooLarge(total, maxBytes))
        return
      }
      chunks.push(chunk)
    })
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    process.stdin.on('error', reject)
  })
}
