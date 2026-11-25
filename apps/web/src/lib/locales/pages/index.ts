import { artifactsZh } from "./artifacts";
import { authorityZh } from "./authority";
import { channelsZh } from "./channels";
import { chatZh } from "./chat";
import { codingZh } from "./coding";
import { mcpZh } from "./mcp";
import { observabilityZh } from "./observability";
import { requirementsZh } from "./requirements";
import { settingsZh } from "./settings";
import { skillsZh } from "./skills";
import { teamZh } from "./team";
import { todayZh } from "./today";
import { wikiZh } from "./wiki";
import { workflowsZh } from "./workflows";

/** Every page's dictionary in one object. `zh.ts` spreads it after its own keys, so a page's
 *  wording for the strings it owns wins, and a page ships its words with its markup. */
export const pageZh: Record<string, string> = {
  ...channelsZh,
  ...observabilityZh,
  ...requirementsZh,
  ...teamZh,
  ...wikiZh,
  ...mcpZh,
  ...skillsZh,
  ...authorityZh,
  ...artifactsZh,
  ...settingsZh,
  ...workflowsZh,
  ...chatZh,
  ...codingZh,
  ...todayZh,
};
