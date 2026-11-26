"use client";

import { useParams } from "next/navigation";
import { TeamScreen } from "../_components/team-screen";

/** `/team/<id>`: the registry with this member's detail open. */
export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  return <TeamScreen view={{ kind: "detail", agentId }} />;
}
