import type { ModelRegistry } from "@my-agent-team/core";
import { Elysia } from "elysia";

export function modelRoutes(registry: ModelRegistry) {
  return new Elysia().get("/api/models", () => {
    return {
      providers: registry.getProviders().map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        models: p.getModels(),
      })),
    };
  });
}
