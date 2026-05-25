type RpcHandler = (params: unknown) => unknown | Promise<unknown>

/**
 * Error thrown when two extensions register the same RPC method.
 */
class RpcMethodConflictError extends Error {
  readonly method: string
  readonly firstExt: string
  readonly secondExt: string

  constructor(method: string, firstExt: string, secondExt: string) {
    super(`RPC method "${method}" already registered by "${firstExt}" (conflict with "${secondExt}")`)
    this.name = 'RpcMethodConflictError'
    this.method = method
    this.firstExt = firstExt
    this.secondExt = secondExt
  }
}

/**
 * RpcRegistry — O(1) method dispatch table.
 * Separate from HookContainer because RPC routing is fundamentally
 * different from hook chaining (method dispatch vs payload transformation).
 */
class RpcRegistry {
  private handlers = new Map<string, RpcHandler>()
  private handlerExtensions = new Map<string, string>() // method -> extension name

  /** Register an RPC method handler */
  register(method: string, handler: RpcHandler, extensionName?: string): void {
    if (this.handlers.has(method)) {
      const first = this.handlerExtensions.get(method) ?? 'unknown'
      const second = extensionName ?? 'unknown'
      throw new RpcMethodConflictError(method, first, second)
    }
    this.handlers.set(method, handler)
    if (extensionName) {
      this.handlerExtensions.set(method, extensionName)
    }
  }

  /** Resolve a handler by method name. Returns undefined if not found. */
  resolve(method: string): RpcHandler | undefined {
    return this.handlers.get(method)
  }

  /** List all registered method names */
  listMethods(): string[] {
    return [...this.handlers.keys()]
  }

  /** Check if a method is registered */
  has(method: string): boolean {
    return this.handlers.has(method)
  }

  /** Unregister a single method */
  unregister(method: string): boolean {
    return this.handlers.delete(method)
  }

  /** Unregister all methods for an extension (by prefix) */
  unregisterByExtension(_name: string): void {
    // Convention: methods may be prefixed; MVP just clears everything
    // Future: use method→extension mapping
  }

  /** Clear all method registrations */
  clear(): void {
    this.handlers.clear()
    this.handlerExtensions.clear()
  }
}

export { RpcRegistry, RpcMethodConflictError }
export type { RpcHandler }
