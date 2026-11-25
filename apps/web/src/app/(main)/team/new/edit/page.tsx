"use client";

import { TeamScreen } from "../../_components/team-screen";

/** `/team/new/edit`: the registry with the new-member sheet open. A PA's proposal for a new
 *  member only fills this form; the member exists once the person presses Create. */
export default function NewAgentEditPage() {
  return <TeamScreen view={{ kind: "new" }} />;
}
