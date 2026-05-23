const ERROR_BODY_PREVIEW_CHARS = 200

/** Normalized HTTP error for LLM provider responses. */
class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Normalize a fetch Response into a typed HttpError. */
export async function normalizeHttpError(resp: Response, provider: string): Promise<HttpError> {
  const body = await resp.text().catch(() => '<unreadable>')
  return new HttpError(
    `[${provider}] HTTP ${resp.status}: ${resp.statusText} — ${body.slice(0, ERROR_BODY_PREVIEW_CHARS)}`,
    resp.status,
    body,
  )
}
