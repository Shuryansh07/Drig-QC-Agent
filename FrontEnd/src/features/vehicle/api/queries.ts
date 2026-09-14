import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import type { RecentVehicle, VehicleMatch } from "@/types/contracts";

export function useVehicleLookup(query: string) {
  return useQuery({
    queryKey: queryKeys.vehicleLookup(query),
    enabled: query.trim().length >= 2,
    queryFn: () =>
      apiFetch<VehicleMatch[]>(`/vehicles/lookup?q=${encodeURIComponent(query)}`),
  });
}

/**
 * L3 recall (BACKEND_MEMORY.md §5) is a UI convenience only — "you were working
 * on a 2021 Transit an hour ago". It never reaches the model prompt.
 */
export function useRecentVehicles() {
  return useQuery({
    queryKey: queryKeys.recentVehicles(),
    queryFn: () => apiFetch<RecentVehicle[]>("/vehicles/recent"),
  });
}
