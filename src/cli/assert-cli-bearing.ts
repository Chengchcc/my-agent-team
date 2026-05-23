import type { CliManifest } from './cli-types'

/** Compile-time assertion: a module exports cliManifest. Missing export → tsc error. */
export type AssertHasCliManifest<M extends { cliManifest: CliManifest }> = M
