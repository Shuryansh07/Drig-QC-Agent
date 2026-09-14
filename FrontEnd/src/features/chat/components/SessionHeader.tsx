import { Link } from "react-router";
import { Car } from "lucide-react";
import type { QueryFrame } from "@/types/contracts";

interface SessionHeaderProps {
  frame: QueryFrame | null;
}

/**
 * One line. The vehicle in the frame is the single most useful thing to keep on
 * screen — it is what retrieval is scoped to, and getting it wrong is the most
 * expensive mistake the system can make.
 */
export function SessionHeader({ frame }: SessionHeaderProps) {
  const vehicle =
    frame?.make && frame.model
      ? `${frame.year ?? ""} ${frame.make} ${frame.model}`.trim()
      : null;

  return (
    <div className="mx-auto flex w-full max-w-[42rem] items-center gap-3 px-5 py-3">
      <Car className="text-muted-foreground size-5 shrink-0" aria-hidden />
      {vehicle ? (
        <p className="text-body truncate font-medium">{vehicle}</p>
      ) : (
        <p className="text-body text-muted-foreground">No vehicle set</p>
      )}
      <Link
        to="/vehicle"
        className="text-micro text-primary ml-auto inline-flex min-h-touch items-center px-2 font-medium"
      >
        Change
      </Link>
    </div>
  );
}
