import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { authKeys } from "./query-keys";

export function authPasswordQuery() {
  return queryOptions({
    queryKey: authKeys.password,
    queryFn: api.getAuthPassword,
  });
}
