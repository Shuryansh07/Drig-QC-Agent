import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useRecentVehicles, useVehicleLookup } from "@/features/vehicle/api/queries";
import type { VehicleMatch } from "@/types/contracts";

interface VehiclePickerProps {
  onPick: (vehicle: VehicleMatch) => void;
}

/**
 * Skeleton. Alias handling ("Transit Custom" vs "Tourneo") lives on the server;
 * this shows the alias that matched so a technician can see why a result appeared.
 */
export function VehiclePicker({ onPick }: VehiclePickerProps) {
  const [query, setQuery] = useState("");
  const { data: matches = [] } = useVehicleLookup(query);
  const { data: recent = [] } = useRecentVehicles();

  const showRecent = query.trim().length < 2 && recent.length > 0;

  return (
    <div className="space-y-4">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Make, model, year"
        autoComplete="off"
        className="text-body h-touch"
      />

      {showRecent ? (
        <div className="space-y-2">
          <p className="text-micro text-muted-foreground font-medium">Recently worked on</p>
          {recent.map((vehicle) => (
            <Button
              key={`${vehicle.make}-${vehicle.model}-${vehicle.year}`}
              variant="outline"
              onClick={() =>
                onPick({ ...vehicle, startType: null, confidence: 1 })
              }
              className="h-touch w-full justify-start text-body"
            >
              {vehicle.year} {vehicle.make} {vehicle.model}
            </Button>
          ))}
        </div>
      ) : null}

      {matches.map((match) => (
        <Button
          key={`${match.make}-${match.model}-${match.year}`}
          variant="outline"
          onClick={() => onPick(match)}
          className="h-auto min-h-touch w-full flex-col items-start gap-1 py-3 text-body"
        >
          <span className="font-medium">
            {match.year} {match.make} {match.model}
          </span>
          {match.matchedAlias ? (
            <span className="text-micro text-muted-foreground font-normal">
              matched “{match.matchedAlias}”
            </span>
          ) : null}
        </Button>
      ))}
    </div>
  );
}
