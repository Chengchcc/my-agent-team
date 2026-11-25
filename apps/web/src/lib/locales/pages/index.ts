import { channelsZh } from "./channels";
import { observabilityZh } from "./observability";
import { requirementsZh } from "./requirements";
import { teamZh } from "./team";
import { wikiZh } from "./wiki";

/** Every page's dictionary in one object. `zh.ts` spreads it after its own keys, so a page's
 *  wording for the strings it owns wins, and a page ships its words with its markup. */
export const pageZh: Record<string, string> = {
  ...channelsZh,
  ...observabilityZh,
  ...requirementsZh,
  ...teamZh,
  ...wikiZh,
};
