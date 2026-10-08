import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  CloudDownload,
  LoaderCircle,
  ScanSearch,
  Square,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import { useDriveSyncStatus } from "../api/queries";
import { useScanDrive, useStopDriveSync, useSyncDrive } from "../api/mutations";
import type { DriveSyncRun, DriveSyncStatus } from "../types";
import { DriveSyncFileList } from "./DriveSyncFileList";

const PHASE: Record<DriveSyncStatus["phase"], string> = {
  idle: "Idle",
  scanning: "Checking folder…",
  importing: "Importing…",
};

const errorMessage = (err: unknown): string =>
  err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : "Request failed";

const n = (value: number) => value.toLocaleString();

interface DriveSyncPanelProps {
  /** Jumps the document list to a synced file, to follow its processing there. */
  onShowDocument: (name: string) => void;
}

/**
 * Imports manuals from the shared Google Drive folder the backend is pointed
 * at. "Check folder" only counts (nothing is downloaded); "Sync now" downloads
 * the new or changed files and queues them like uploads. Progress comes from
 * polling GET /api/documents/sync-drive while either is running.
 */
export function DriveSyncPanel({ onShowDocument }: DriveSyncPanelProps) {
  const queryClient = useQueryClient();
  const { data: status, error } = useDriveSyncStatus();
  const sync = useSyncDrive();
  const scan = useScanDrive();
  const stop = useStopDriveSync();

  // When an import ends (manual or automatic): refresh the document list, which
  // has the new files now, and say how it went. A scan alone needs no toast:
  // its counts are on screen.
  const previousPhase = useRef(status?.phase);
  useEffect(() => {
    const was = previousPhase.current;
    previousPhase.current = status?.phase;
    if (!status || was !== "importing" || status.phase !== "idle") return;

    void queryClient.invalidateQueries({
      queryKey: queryKeys.adminDocuments(),
    });
    const run = status.runs[0];
    if (status.last_error) toast.error(status.last_error);
    else if (run?.stopped)
      toast.info(
        `Drive sync stopped: ${n(run.queued)} sent, ${n(run.duplicates)} already imported, ${n(run.failed)} failed`,
      );
    else if (run)
      toast.success(
        `Drive sync done: ${n(run.queued)} sent, ${n(run.duplicates)} already imported, ${n(run.failed)} failed`,
      );
  }, [status, queryClient]);

  if (error) {
    return (
      <div className="border-border bg-card text-micro text-muted-foreground rounded-xl border p-4">
        Couldn&apos;t load the Google Drive sync status: {errorMessage(error)}
      </div>
    );
  }
  if (!status) return null;
  if (!status.configured) {
    return (
      <div className="border-border bg-card text-micro text-muted-foreground rounded-xl border p-4">
        Google Drive sync is not set up (GOOGLE_API_KEY / GDRIVE_FOLDER_ID in
        the backend&apos;s .env).
      </div>
    );
  }

  const busy = status.phase !== "idle";
  const start = (action: typeof sync) =>
    action.mutate(undefined, {
      onError: (err) => toast.error(errorMessage(err)),
    });
  const lastScan = status.last_scan;

  return (
    <section
      aria-label="Google Drive sync"
      className="border-border bg-card space-y-4 rounded-xl border p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-body font-semibold">Google Drive sync</h2>
            <Badge
              variant={busy ? "secondary" : "outline"}
              className="text-micro"
            >
              {busy ? <LoaderCircle className="animate-spin" /> : null}
              {PHASE[status.phase]}
            </Badge>
          </div>
          <p className="text-micro text-muted-foreground">
            {status.auto_sync
              ? `New files are imported automatically every ${status.interval_minutes} minutes.`
              : "Files are imported only when you click Sync now."}
            {status.limit !== null
              ? ` Test mode: only the first ${n(status.limit)} files are synced.`
              : ""}
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          {busy || status.pending_jobs > 0 ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={stop.isPending || status.stopping}
              onClick={() => start(stop)}
            >
              <Square />
              {stop.isPending || status.stopping ? "Stopping…" : "Stop"}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={busy || scan.isPending}
            onClick={() => start(scan)}
          >
            <ScanSearch />
            Check folder
          </Button>
          <Button
            size="sm"
            disabled={busy || sync.isPending}
            onClick={() => {
              stop.reset();
              start(sync);
            }}
          >
            <CloudDownload />
            {status.resumable > 0 ? `Resume sync (${n(status.resumable)} left)` : "Sync now"}
          </Button>
        </div>
      </div>

      {status.phase === "scanning" ? (
        <p className="text-micro text-muted-foreground">
          Listing every subfolder, this can take a minute…
        </p>
      ) : status.last_no_change_at && status.phase === "idle" ? (
        <p className="text-micro text-muted-foreground">
          Last sync {new Date(status.last_no_change_at).toLocaleString()}: no
          new or changed files.
        </p>
      ) : null}

      {status.last_error ? (
        <p
          className="text-micro text-destructive flex items-start gap-1.5"
          role="alert"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{status.last_error}</span>
        </p>
      ) : null}

      {status.runs.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-micro text-muted-foreground font-medium">
            Recent syncs
          </h3>
          {status.runs.map((run, i) => (
            <DriveSyncRunItem
              key={run.id}
              run={run}
              defaultOpen={i === 0}
              onShowDocument={onShowDocument}
            />
          ))}
        </div>
      ) : null}

      {lastScan ? (
        <div className="space-y-3">
          <p className="text-micro text-muted-foreground">
            Last checked {new Date(lastScan.at).toLocaleString()}:{" "}
            <span className="text-foreground font-medium">
              {n(lastScan.supported)}
            </span>{" "}
            importable files ·{" "}
            <span className="text-foreground font-medium">
              {n(lastScan.in_knowledge_base)}
            </span>{" "}
            already in the knowledge base ·{" "}
            <span className="text-foreground font-medium">
              {n(lastScan.remaining)}
            </span>{" "}
            left to import
          </p>

          <div className="overflow-x-auto">
            <table className="text-micro w-full max-w-md">
              <thead className="text-muted-foreground text-left">
                <tr>
                  <th className="py-1 pr-4 font-medium">Type</th>
                  <th className="py-1 pr-4 text-right font-medium">
                    In folder
                  </th>
                  <th className="py-1 text-right font-medium">
                    Left to import
                  </th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(lastScan.by_type)
                  .sort(([, a], [, b]) => b.total - a.total)
                  .map(([type, counts]) => (
                    <tr key={type} className="border-border border-t">
                      <td className="py-1 pr-4">{type}</td>
                      <td className="py-1 pr-4 text-right tabular-nums">
                        {n(counts.total)}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {n(counts.remaining)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {Object.keys(lastScan.skipped).length > 0 ? (
            <p className="text-micro text-muted-foreground">
              Not imported (unsupported type):{" "}
              {Object.entries(lastScan.skipped)
                .sort(([, a], [, b]) => b - a)
                .map(([type, count]) => `${type} ${n(count)}`)
                .join(" · ")}
            </p>
          ) : null}
        </div>
      ) : !busy ? (
        <p className="text-micro text-muted-foreground">
          Click Check folder to count what&apos;s in the Drive folder and how
          much is left to import. Nothing is downloaded.
        </p>
      ) : null}
    </section>
  );
}

interface DriveSyncRunItemProps {
  run: DriveSyncRun;
  defaultOpen: boolean;
  onShowDocument: (name: string) => void;
}

/** One sync in the history: when, how it was started, its counts, and (opened) every file it took on. */
function DriveSyncRunItem({
  run,
  defaultOpen,
  onShowDocument,
}: DriveSyncRunItemProps) {
  const [open, setOpen] = useState(defaultOpen);
  const running = run.finished_at === null;
  const percent =
    run.total > 0 ? Math.round((run.processed / run.total) * 100) : 0;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="border-border space-y-2 rounded-lg border p-3">
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Chevron
          className="text-muted-foreground mt-0.5 size-4 shrink-0"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-micro font-medium">
            {run.trigger === "auto" ? "Automatic sync" : "Manual sync"} ·{" "}
            {new Date(run.started_at).toLocaleString()}
            {running ? " · in progress" : run.stopped ? " · stopped" : ""}
          </p>
          <p className="text-micro text-muted-foreground">
            {n(run.processed)} of {n(run.total)} files · {n(run.queued)} sent ·{" "}
            {n(run.duplicates)} already imported ·{" "}
            <span className={run.failed > 0 ? "text-destructive" : undefined}>
              {n(run.failed)} failed
            </span>
            {running && run.current ? ` · now: ${run.current}` : ""}
          </p>
        </div>
      </button>

      {running ? (
        <Progress value={percent} aria-label="Drive sync progress" />
      ) : null}
      {run.error ? (
        <p className="text-micro text-destructive">{run.error}</p>
      ) : null}
      {open ? (
        <DriveSyncFileList files={run.files} onShowDocument={onShowDocument} />
      ) : null}
    </div>
  );
}
