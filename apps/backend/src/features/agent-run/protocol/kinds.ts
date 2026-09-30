import { z } from "zod";

/** The execution rail the Product Backend dispatches to (ADR 0040): ONE
 *  kind, ONE adapter. The product's vocabulary is harness + model; this
 *  constant is the implementation detail that says which adapter starts the
 *  child, and it stays a list only because the registry, the preflight error
 *  and the wire schema read it as one. */
export const BACKEND_KINDS = ["acp"] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

export const backendKindSchema = z.enum(BACKEND_KINDS);
