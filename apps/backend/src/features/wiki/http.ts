import { Elysia } from "elysia";
import type { WikiService } from "./service.js";

/** ADR 0074 S3: the wiki is READ-ONLY over HTTP. Writes happen through the
 *  product tools (agent identity, CAS, ownership) or through git by a person —
 *  a generic write endpoint would be a second, unaudited door. */
export function wikiRoutes(svc: WikiService) {
  return new Elysia()
    .get("/api/wiki/pages", () => ({ pages: svc.list() }))
    .get("/api/wiki/page", ({ query, set }) => {
      const path = query.path ?? "";
      const page = svc.read(path);
      if (page === null) {
        set.status = 404;
        return { error: `wiki page not found: ${path}` };
      }
      return page;
    })
    .get("/api/wiki/query", ({ query }) => {
      const text = query.text;
      const request: { text?: string; limit?: number } = {};
      if (text !== undefined) request.text = text;
      return { hits: svc.query(request) };
    })
    .get("/api/wiki/backlinks", ({ query, set }) => {
      const path = query.path ?? "";
      if (svc.read(path) === null) {
        set.status = 404;
        return { error: `wiki page not found: ${path}` };
      }
      return { backlinks: svc.backlinks(path) };
    })
    .get("/api/wiki/lint", () => ({ findings: svc.lint() }));
}
