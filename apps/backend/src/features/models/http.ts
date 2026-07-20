import { Elysia } from "elysia";
import type { ModelRegistry } from "@my-agent-team/core";

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
