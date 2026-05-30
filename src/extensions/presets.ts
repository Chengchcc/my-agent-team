import toolCatalogExt from './tool-catalog'
import traceExt from './trace'
import providerExt from './provider'
import sessionExt from './session'
import memoryExt from './memory'
import identityExt from './identity'
import skillsExt from './skills'
import toolsExt from './tools'
import permissionExt from './permission'
import controlplaneExt from './controlplane'
import controlplaneMethodsExt from './controlplane/methods'
import dataplaneExt from './dataplane'
import transportInmemExt from './transport.inmem'
import { transportUnix as transportUnixExt } from './transport.unix'
import evolutionExt from './evolution'
import mcpExt from './mcp'
import infraServicesExt from './infra-services'
import frontendLarkExt from './frontend.lark'
import frontendCapabilityHintsExt from './frontend-capability-hints'

// Multi-extension preset
export const domainCore = [toolCatalogExt(), traceExt(), providerExt(), sessionExt(), toolsExt(), permissionExt(), controlplaneExt(), controlplaneMethodsExt(), dataplaneExt()]
export const frontendCapabilityHints = [frontendCapabilityHintsExt()]

// Single-extension presets (named exactly after the extension, no "Preset" suffix)
export const memory = [memoryExt()]
export const identity = [identityExt()]
export const skills = (opts?: { builtinDir?: string; agentDir?: string; extraPaths?: string[] }) => [skillsExt(opts)]
export const evolution = [evolutionExt()]
export const mcp = [mcpExt()]
export const infraServices = [infraServicesExt()]
export const transportInmem = [transportInmemExt()]
export const transportUnix = (cfg: { socketPath: string }) => [transportUnixExt(cfg)]
export const frontendLark = [frontendLarkExt()]
