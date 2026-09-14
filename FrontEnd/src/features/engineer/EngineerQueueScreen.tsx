import { PageShell } from "@/components/common/PageShell";
import { EmptyState } from "@/components/common/EmptyState";
import { useHandoffQueue } from "@/features/engineer/api/queries";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

export default function EngineerQueueScreen() {
  const { data: handoffs, isPending } = useHandoffQueue();

  return (
    <PageShell>
      <h1 className="text-title font-semibold tracking-tight">Waiting on you</h1>

      {isPending ? (
        <div className="mt-6 space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : !handoffs || handoffs.length === 0 ? (
        <EmptyState
          title="Nothing queued"
          body="Handoffs from technicians land here. You'll see the vehicle and everything they already tried."
        />
      ) : (
        <ul className="mt-6 space-y-3">
          {handoffs.map((handoff) => (
            <li
              key={handoff.handoffId}
              className="border-border bg-card rounded-xl border p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-body font-medium">{handoff.technicianName}</p>
                <Badge variant="secondary" className="text-micro shrink-0">
                  {handoff.status}
                </Badge>
              </div>
              <p className="text-body text-muted-foreground mt-2">{handoff.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
