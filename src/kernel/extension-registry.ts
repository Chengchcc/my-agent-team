import type { ExtensionBuilder, ExtensionApplyResult } from './define-extension'
import type { SlashCommand } from '../application/slash'
import type { CapabilityKey, CapabilityMap } from './capability-map'

interface ExtInstance {
  readonly name: string
  readonly builder: ExtensionBuilder
  readonly result: ExtensionApplyResult
}

interface CapEntry {
  instance: ExtInstance
  key: string
  factory: () => unknown
}

/**
 * ExtensionRegistry stores runtime extension instances and provides capability
 * lookups by typed path (e.g. 'provider.llm', 'session.store').
 * Capabilities are lazy — the factory returned by get() is called by the consumer.
 */
class ExtensionRegistry {
  private instances = new Map<string, ExtInstance>()
  /** O(1) capability index: full capability key → { instance, factory } */
  private caps = new Map<string, CapEntry>()

  register(builder: ExtensionBuilder, result: ExtensionApplyResult): void {
    if (this.instances.has(builder.name)) {
      throw new Error(`Extension "${builder.name}" is already registered`)
    }
    const instance: ExtInstance = {
      name: builder.name,
      builder,
      result,
    }
    this.instances.set(builder.name, instance)

    // Index capabilities by their full key for O(1) lookup.
    // The provide block keys are now full CapabilityKey strings (e.g. 'session.store').
    for (const [key, factory] of Object.entries(result.provide ?? {})) {
      if (this.caps.has(key)) {
        const existing = this.caps.get(key)!
        throw new CapabilityConflictError(key, existing.instance.name, builder.name)
      }
      this.caps.set(key, { instance, key, factory })
    }
  }

  /**
   * Get a capability by typed path (e.g. 'session.store').
   * Checks kernel provides first, then the capability index.
   */
  get<K extends CapabilityKey>(key: K): CapabilityMap[K]
  get(key: string): unknown
  get(key: string): unknown {
    // Option A: kernel-provided capability
    const kernelValue = this.kernelProvides.get(key)
    if (kernelValue !== undefined) {
      return kernelValue
    }

    // Option B: full extension name as direct fallback
    const directInstance = this.instances.get(key)
    if (directInstance) {
      return directInstance as unknown
    }

    // Option C: capability index lookup
    const cap = this.caps.get(key)
    if (!cap) {
      throw new CapabilityNotFoundError(key)
    }
    return cap.factory()
  }

  /**
   * Check if a typed capability exists.
   */
  has<K extends CapabilityKey>(key: K): boolean
  has(key: string): boolean
  has(key: string): boolean {
    if (this.kernelProvides.has(key)) return true
    if (this.instances.has(key)) return true
    return this.caps.has(key)
  }

  private kernelProvides = new Map<string, unknown>()

  /**
   * Register a kernel-level capability before any extension runs.
   * Kernel provides are available to all extensions via get() and has().
   */
  provideKernel<K extends CapabilityKey>(key: K, value: CapabilityMap[K]): void
  provideKernel(key: string, value: unknown): void
  provideKernel(key: string, value: unknown): void {
    this.kernelProvides.set(key, value)
  }

  /**
   * Remove an extension and its capabilities.
   */
  unregister(name: string): boolean {
    const instance = this.instances.get(name)
    if (!instance) return false
    // Remove capability entries owned by this extension
    for (const [key, entry] of this.caps) {
      if (entry.instance.name === name) {
        this.caps.delete(key)
      }
    }
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

class CapabilityConflictError extends Error {
  readonly key: string
  readonly extensionA: string
  readonly extensionB: string
  constructor(key: string, extA: string, extB: string) {
    super(`Capability "${key}" already registered by "${extA}" — conflict with "${extB}"`)
    this.name = 'CapabilityConflictError'
    this.key = key
    this.extensionA = extA
    this.extensionB = extB
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

export { ExtensionRegistry, CapabilityConflictError }
export type { ExtInstance }
