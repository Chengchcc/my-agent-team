/**
 * WidgetPayloadMap — Single Source of Truth for widget name <-> payload shape.
 *
 * Extensions enhance this via declare module in their widget-payloads.ts files.
 * TUI's widget-registry.ts uses keyof WidgetPayloadMap to type-check WIDGETS.
 *
 * Adding a widget:
 *   1. ext: widget-payloads.ts — define payload + declare module
 *   2. contracts: (auto-merged, no changes needed)
 *   3. TUI: widget-registry.ts add side-effect import + WIDGETS entry
 *
 * A19.6 + A19.7 enforce all three stay in sync.
 */
export interface WidgetPayloadMap {
  // Intentionally empty — enhanced by extensions via declare module
}

export type WidgetName = keyof WidgetPayloadMap

export type WidgetPayloadFor<W extends WidgetName> = WidgetPayloadMap[W]
