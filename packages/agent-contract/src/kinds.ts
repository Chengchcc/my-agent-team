import { z } from "zod";

/** The full set of execution backends the Product Backend can dispatch to.
 *  Each kind has exactly one adapter package implementing `AgentBackend<K>`:
 *  - oma: 自家 child (apps/oh-my-agent --mode rpc)
 *  - claude_code:   Claude Code CLI (--output-format stream-json)
 *  - pi:            pi CLI (@earendil-works/pi-oma, -p --mode json)
 *  - omp:           omp CLI (@oh-my-pi/pi-oma, -p --mode json)
 *  - acp:           any ACP agent (adapter-acp, ADR 0039 decision 4: omp
 *                   native, cc/pi via bridges; the model id selects the
 *                   registry entry)
 *
 *  The wire contract in transport.ts accepts this union; a child enforces
 *  its own kind at runtime (see oma rpc-mode). */
export const BACKEND_KINDS = ["oma", "claude_code", "pi", "omp", "acp"] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

export const backendKindSchema = z.enum(BACKEND_KINDS);
