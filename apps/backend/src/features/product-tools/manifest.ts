import { PRODUCT_TOOLS } from "./dispatch.js";

/** Product Tool manifest (ADR 0003 decision 6): the fixed tool definitions
 *  the oma exposes over MCP. Derived directly from `PRODUCT_TOOLS` (single
 *  source of truth — eliminates manifest ↔ ListTools schema drift). */
export interface ProductToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly entrypoint: string;
}

export function buildHistoryTools(entrypoint: string): readonly ProductToolDescriptor[] {
  return PRODUCT_TOOLS.map((tool) => ({ ...tool, entrypoint }));
}
