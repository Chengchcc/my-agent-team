import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const modelKeys = {
  all: ["models"] as const,
};

export const harnessKeys = {
  all: ["harnesses"] as const,
};

function harnessListQuery() {
  return queryOptions({ queryKey: harnessKeys.all, queryFn: api.listHarnesses });
}

/** The harnesses and the models each declares. Costs a probe server-side, so it
 *  is cached by react-query and refetched only when a harness is (re)configured. */
export function useHarnessList() {
  return useQuery(harnessListQuery());
}

function modelListQuery() {
  return queryOptions({ queryKey: modelKeys.all, queryFn: api.listModels });
}

export function useModelList() {
  return useQuery(modelListQuery());
}
