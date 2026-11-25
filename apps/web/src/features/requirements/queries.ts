import { queryOptions } from "@tanstack/react-query";
import { type ApiReturn, api } from "@/lib/api";
import { client, unwrap } from "@/lib/client";

/** A tracked goal as the list reports it: the stored status only. The status a person reads
 *  (in progress, waiting for you, ready for acceptance) derives from records and comes with the
 *  detail. */
export type RequirementListRow = ApiReturn<typeof api.listRequirements>["requirements"][number];
/** One goal with the facts its status derives from: its runs and their open requests. The route
 *  also types a not-found body; that never reaches a reader, because the client throws on it. */
type RequirementDetailResponse = ApiReturn<typeof api.getRequirement>;
export type RequirementDetail = Exclude<RequirementDetailResponse, { error: string }>;

/** Whether a detail response carries a goal (a client that swallowed the error may hand over the
 *  not-found body instead). */
export function isRequirementDetail(
  value: RequirementDetailResponse | undefined,
): value is RequirementDetail {
  if (value === undefined) return false;
  return "requirement" in value;
}
export type RequirementRecord = RequirementDetail["requirement"];
export type RequirementRunFact = RequirementDetail["runs"][number];
export type RequirementRequestFact = RequirementDetail["requests"][number];

export const requirementKeys = {
  all: ["requirements"] as const,
  detail: (id: string) => ["requirements", id] as const,
};

/** Every tracked goal, finished and cancelled ones included. The list has a status filter, and
 *  the endpoint hides two of the statuses unless it is asked for the closed ones. */
export function requirementsQuery() {
  return queryOptions({
    queryKey: requirementKeys.all,
    queryFn: () => unwrap(client.api.requirements.get({ query: { closed: "1" } })),
  });
}

export function requirementDetailQuery(id: string) {
  return queryOptions({
    queryKey: requirementKeys.detail(id),
    queryFn: () => api.getRequirement(id),
    staleTime: 15_000,
  });
}
