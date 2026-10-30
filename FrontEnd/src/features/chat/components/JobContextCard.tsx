import { useQuery } from "@tanstack/react-query";
import { BookOpen, Car, ClipboardList, Cpu } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import type { JobContext, JobContextResponse } from "@/features/chat/lib/jobContext";

/** Shown at most; the rest are counted. */
const MAX_MANUALS_SHOWN = 4;

const manualName = (title: string) => title.replace(/\.(pdf|docx|jpe?g|png)$/i, "");

/**
 * The job this chat was opened from, and the manuals its equipment points at: the technician sees the
 * assistant already knows the car and which manuals to look in, before asking anything.
 */
export function JobContextCard({ job }: { job: JobContext }) {
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.jobContext(job.equipment ?? "", job.car ?? ""),
    queryFn: () => {
      const params = new URLSearchParams();
      if (job.equipment) params.set("equipment", job.equipment);
      if (job.car) params.set("car", job.car);
      return apiFetch<JobContextResponse>(`/rag/job-context?${params}`);
    },
    enabled: Boolean(job.equipment),
    staleTime: 5 * 60_000,
  });
  const manuals = data?.manuals ?? [];

  return (
    <section aria-label="Job" className="border-border bg-card w-full space-y-3 rounded-xl border p-4 text-left">
      <div className="text-micro text-muted-foreground flex items-center gap-2 font-medium tracking-wide uppercase">
        <ClipboardList className="size-4" aria-hidden />
        {job.id ? `Job ${job.id}` : "From the jobsheet"}
      </div>

      <dl className="text-body grid gap-2 sm:grid-cols-2">
        {job.car ? (
          <div className="flex items-center gap-2">
            <Car className="text-muted-foreground size-4 shrink-0" aria-hidden />
            <dt className="sr-only">Vehicle</dt>
            <dd className="font-medium">{job.car}</dd>
          </div>
        ) : null}
        {job.equipment ? (
          <div className="flex items-center gap-2">
            <Cpu className="text-muted-foreground size-4 shrink-0" aria-hidden />
            <dt className="sr-only">Equipment</dt>
            <dd className="font-medium">{job.equipment}</dd>
          </div>
        ) : null}
      </dl>

      {job.equipment ? (
        <div className="border-border space-y-2 border-t pt-3">
          {isPending ? (
            <Skeleton className="h-5 w-2/3" />
          ) : isError ? (
            <p className="text-micro text-muted-foreground">Couldn&apos;t check the manuals right now; every manual will be searched.</p>
          ) : manuals.length === 0 ? (
            <p className="text-micro text-muted-foreground">
              No manual names the {job.equipment}, so every manual will be searched.
            </p>
          ) : (
            <>
              <p className="text-micro text-muted-foreground">
                Answers come from {manuals.length === 1 ? "this manual" : `these ${manuals.length} manuals`} unless you ask
                about other equipment:
              </p>
              <ul className="space-y-1">
                {manuals.slice(0, MAX_MANUALS_SHOWN).map((m) => (
                  <li key={m.document_id} className="text-micro flex items-start gap-2">
                    <BookOpen className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
                    <span className="break-words">{manualName(m.title)}</span>
                  </li>
                ))}
              </ul>
              {manuals.length > MAX_MANUALS_SHOWN ? (
                <p className="text-micro text-muted-foreground">and {manuals.length - MAX_MANUALS_SHOWN} more</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {job.car ? (
        <p className="text-micro text-muted-foreground">Wiring questions use the {job.car} without asking for it again.</p>
      ) : null}
    </section>
  );
}
