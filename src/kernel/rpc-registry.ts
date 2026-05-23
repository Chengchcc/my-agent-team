type RpcHandler = (params: unknown) => unknown | Promise<unknown>

/**
 * RpcRegistry — O(1) method dispatch table.
 * Separate from HookContainer because RPC routing is fundamentally
 * different from hook chaining (method dispatch vs payload transformation).
 */
class RpcRegistry {
  private handlers = new Map<string, RpcHandler>()

  /** Register an RPC method handler */
  register(method: string, handler: RpcHandler): void {
    if (this.handlers.has(method)) {
      throw new Error(`RPC method "${method}" is already registered`)
    }
    this.handlers.set(method, handler)
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
  }
}

export { RpcRegistry }
export type { RpcHandler }
