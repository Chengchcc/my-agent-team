/** The tabs of a workflow's saved overview. */
export type OverviewTab = "overview" | "executions" | "triggers" | "dsl";

const TABS: ReadonlyArray<OverviewTab> = ["overview", "executions", "triggers", "dsl"];

/** The tab a `?tab=` address names. Anything else, or nothing, is the overview. Lives outside
 *  the overview component because that one is a Client Component, and the page that reads the
 *  address renders on the server. */
export function overviewTabOf(key: string | undefined): OverviewTab {
  if (key === undefined) {
    return "overview";
  }
  const known = TABS.find((tab) => tab === key);
  if (known === undefined) {
    return "overview";
  }
  return known;
}
