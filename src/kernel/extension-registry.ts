import type { ExtensionBuilder, ExtensionApplyResult } from './define-extension'
import type { SlashCommand } from '../application/slash'

interface ExtInstance {
  readonly name: string
  readonly builder: ExtensionBuilder
  readonly result: ExtensionApplyResult
}

/**
 * ExtensionRegistry stores runtime extension instances and provides capability
 * lookups by path (e.g. 'provider.chat'). Capabilities are lazy — the factory
 * returned by get() is called by the consumer.
 */
class ExtensionRegistry {
  private instances = new Map<string, ExtInstance>()

  register(builder: ExtensionBuilder, result: ExtensionApplyResult): void {
    if (this.instances.has(builder.name)) {
      throw new Error(`Extension "${builder.name}" is already registered`)
    }
    this.instances.set(builder.name, {
      name: builder.name,
      builder,
      result,
    })
  }

  /**
   * Get a capability by path (e.g. 'provider.chat').
   * Tries kernel provides first, then full extension name (for extensions
   * with dots like 'frontend.lark'), then splits on first '.' for capability lookup.
   */
  get<T = unknown>(path: string): T {
    // Option A: kernel-provided capability
    const kernelValue = this.kernelProvides.get(path)
    if (kernelValue !== undefined) {
      return kernelValue as T
    }

    // Option B: try full path as extension name first
    const directInstance = this.instances.get(path)
    if (directInstance) {
      return directInstance as unknown as T
    }

    // Fallback: split on first '.' for capability path
    const dotIndex = path.indexOf('.')
    if (dotIndex === -1) {
      throw new CapabilityNotFoundError(path)
    }
    const extName = path.slice(0, dotIndex)
    const capabilityName = path.slice(dotIndex + 1)
    if (!extName || !capabilityName) {
      throw new CapabilityNotFoundError(path)
    }
    // Check kernel provides by full path
    const kernelFullValue = this.kernelProvides.get(`${extName}.${capabilityName}`)
    if (kernelFullValue !== undefined) {
      return kernelFullValue as T
    }
    const instance = this.instances.get(extName)
    if (!instance) {
      throw new CapabilityNotFoundError(path)
    }
    const factory = instance.result.provide?.[capabilityName]
    if (!factory) {
      throw new CapabilityNotFoundError(path)
    }
    return factory() as T
  }

  /**
   * Check if a capability exists.
   */
  has(path: string): boolean {
    // Try full extension name first
    if (this.instances.has(path)) return true
    // Check kernel-provided capabilities
    if (this.kernelProvides.has(path)) return true
    // Fallback: split on first '.'
    const dotIndex = path.indexOf('.')
    if (dotIndex === -1) return false
    const extName = path.slice(0, dotIndex)
    const capabilityName = path.slice(dotIndex + 1)
    if (!extName || !capabilityName) return false
    // Check kernel provides by full path
    if (this.kernelProvides.has(`${extName}.${capabilityName}`)) return true
    const instance = this.instances.get(extName)
    return !!instance?.result.provide?.[capabilityName]
  }

  private kernelProvides = new Map<string, unknown>()

  /**
   * Register a kernel-level capability before any extension runs.
   * Kernel provides are available to all extensions via get() and has().
   */
  provideKernel<T = unknown>(path: string, value: T): void {
    this.kernelProvides.set(path, value)
  }

  /**
   * Remove an extension and its capabilities.
   */
  unregister(name: string): boolean {
    return this.instances.delete(name)
  }

  /**
   * List registered extension names in registration order.
   */
  list(): string[] {
    return [...this.instances.keys()]
  }

  /**
   * Get the full extension instance record.
   */
  getExtension(name: string): ExtInstance | undefined {
    return this.instances.get(name)
  }

  /** Collect all slash commands from registered extensions in registration order. */
  collectSlashCommands(): SlashCommand[] {
    const out: SlashCommand[] = []
    for (const inst of this.instances.values()) {
      for (const cmd of inst.result.slash ?? []) out.push(cmd)
    }
    return out
  }

  get size(): number {
    return this.instances.size
  }
}

class CapabilityNotFoundError extends Error {
  readonly path: string
  constructor(path: string) {
    super(`Capability not found: "${path}"`)
    this.name = 'CapabilityNotFoundError'
    this.path = path
  }
}

export { ExtensionRegistry }
export type { ExtInstance }
