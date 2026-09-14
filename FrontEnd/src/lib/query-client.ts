import { QueryClient } from "@tanstack/react-query";
import { isAuthError } from "@/lib/api-client";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, err) => !isAuthError(err) && count < 2,
      // A technician switching to the camera and back shouldn't trigger a
      // refetch storm on a patchy connection.
      refetchOnWindowFocus: false,
    },
  },
});

export const queryKeys = {
  conversation: (sessionId: string) => ["conversation", sessionId] as const,
  citation: (chunkId: string) => ["citation", chunkId] as const,
  handoffQueue: () => ["handoff", "queue"] as const,
  vehicleLookup: (q: string) => ["vehicle", "lookup", q] as const,
  recentVehicles: () => ["vehicle", "recent"] as const,
} as const;
