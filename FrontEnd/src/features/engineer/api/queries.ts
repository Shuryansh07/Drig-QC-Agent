import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import type { Handoff } from "@/types/contracts";

/** Polled, server truth (§3). */
export function useHandoffQueue() {
  return useQuery({
    queryKey: queryKeys.handoffQueue(),
    queryFn: () => apiFetch<Handoff[]>("/handoffs?status=open"),
    refetchInterval: 30_000,
  });
}
