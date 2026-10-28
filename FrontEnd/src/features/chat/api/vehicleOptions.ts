import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";

/** GET /api/wiring/vehicle-options (BackEnd/src/controllers/wiring.controller.js). */
export interface VehicleModelOption {
  model: string;
  years: number[];
  /** Which start types the DRIG guide / Wiresheet split this model by ("pts", "key"). */
  startTypes: string[];
}

/** Every make the DRIG wiring guide or Wiresheet covers. Changes only when a guide is imported. */
export function useVehicleMakes() {
  return useQuery({
    queryKey: queryKeys.vehicleOptions(),
    queryFn: () => apiFetch<{ makes: string[] }>("/wiring/vehicle-options"),
    staleTime: 10 * 60_000,
  });
}

/** One make's models, with the years and start types either source has. */
export function useVehicleModels(make: string) {
  return useQuery({
    queryKey: queryKeys.vehicleOptions(make),
    enabled: make.trim().length > 0,
    queryFn: () => apiFetch<{ make: string; models: VehicleModelOption[] }>(`/wiring/vehicle-options?make=${encodeURIComponent(make)}`),
    staleTime: 10 * 60_000,
  });
}
