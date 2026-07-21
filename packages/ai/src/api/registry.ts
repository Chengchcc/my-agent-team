import type { Api, ApiImplementation } from "../types.js";

const registry = new Map<Api, ApiImplementation>();

export function registerApi(api: Api, impl: ApiImplementation): void {
  registry.set(api, impl);
}

export function getApiImplementation(api: Api): ApiImplementation | undefined {
  return registry.get(api);
}
