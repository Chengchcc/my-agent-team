"use client";

import { useParams } from "next/navigation";
import { TeamScreen } from "../../_components/team-screen";

/** `/team/<id>/edit`: the registry with this member's editor sheet open. */
export default function AgentEditPage() {
  const { agentId } = useParams<{ agentId: string }>();
  return <TeamScreen view={{ kind: "edit", agentId }} />;
}
