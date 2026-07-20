import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const modelKeys = {
  all: ["models"] as const,
};

function modelListQuery() {
  return queryOptions({ queryKey: modelKeys.all, queryFn: api.listModels });
}

export function useModelList() {
  return useQuery(modelListQuery());
}
