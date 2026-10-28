import { useState } from "react";
import { CircleCheck, Download, LoaderCircle, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, apiUrl, authHeaders } from "@/lib/api-client";
import { useWiringImports } from "../api/queries";
import { useUploadWiringGuide } from "../api/mutations";
import { UploadDropzone } from "./UploadDropzone";
import { MAX_WIRING_GUIDE_BYTES, isImportInFlight, type WiringImport, type WiringImportStatus } from "../types";

const errorMessage = (err: unknown): string =>
  err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Something went wrong";

const STATUS: Record<WiringImportStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  queued: { label: "Queued", variant: "secondary" },
  processing: { label: "Importing", variant: "secondary" },
  completed: { label: "Imported", variant: "default" },
  completed_with_errors: { label: "Imported · some links failed", variant: "outline" },
  failed: { label: "Failed", variant: "destructive" },
};

const n = (value: number | undefined) => (value ?? 0).toLocaleString();

/** One import: where it is, and what came out of the links and photos. */
function ImportRow({ item }: { item: WiringImport }) {
  const c = item.counts;
  const status = STATUS[item.status];
  const inFlight = isImportInFlight(item.status);
  const linksPct = c.links_total ? Math.round(((c.links_done ?? 0) / c.links_total) * 100) : 0;
  const ocrDone = (c.ocr_done ?? 0) + (c.ocr_no_text ?? 0) + (c.ocr_failed ?? 0);
  const ocrPct = c.ocr_total ? Math.round((ocrDone / c.ocr_total) * 100) : 0;

  return (
    <li className="border-border bg-card space-y-3 rounded-xl border p-4">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
        <p className="text-body min-w-0 font-medium break-words">{item.file_name}</p>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {item.is_live ? (
            <Badge variant="default" className="text-micro">
              <CircleCheck aria-hidden />
              Live
            </Badge>
          ) : null}
          <Badge variant={status.variant} className="text-micro">
            {status.label}
          </Badge>
        </div>
      </div>

      <p className="text-micro text-muted-foreground">
        {[
          c.vehicles !== undefined ? `${n(c.vehicles)} vehicle rows` : null,
          c.cells_text !== undefined ? `${n(c.cells_text)} written values` : null,
          c.links_total !== undefined ? `${n(c.links_total)} distinct links` : null,
          `uploaded ${new Date(item.created_at).toLocaleString()}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      {inFlight ? (
        <div className="space-y-2">
          <p className="text-micro text-muted-foreground">{item.stage ? `Step: ${item.stage}…` : "Waiting for the background worker."}</p>
          {item.stage === "fetching links" ? <Progress value={linksPct} aria-label="Links downloaded" /> : null}
          {item.stage === "reading photos" ? <Progress value={ocrPct} aria-label="Photos read" /> : null}
        </div>
      ) : null}

      {c.links_total !== undefined && (c.links_done ?? 0) > 0 ? (
        <p className="text-micro text-muted-foreground">
          Links: {n(c.links_stored)} stored · {n(c.links_requires_login)} skipped (need a login, e.g. Directechs) ·{" "}
          {n(c.links_unsupported)} not a file · {n(c.links_failed)} failed
          {c.ocr_total !== undefined && c.ocr_total > 0 ? (
            <>
              {" "}
              · Photos read: {n(c.ocr_done)} with text, {n(c.ocr_no_text)} without, {n(c.ocr_failed)} failed
            </>
          ) : null}
        </p>
      ) : null}

      {item.error ? (
        <p className="text-micro text-destructive flex items-start gap-1.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{item.error}</span>
        </p>
      ) : null}
    </li>
  );
}

/**
 * DRIG's vehicle wiring guide (the Excel workbook). The chat looks every
 * vehicle up here first; the scraped Wiresheet data is only used for a circuit
 * this guide has nothing usable for.
 */
export function WiringGuidePanel() {
  const { data, isPending, error, refetch } = useWiringImports();
  const upload = useUploadWiringGuide();

  const handleFiles = (files: File[]) => {
    const file = files[0];
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      toast.error("Only Excel workbooks (.xlsx) can be imported as the wiring guide.");
      return;
    }
    if (file.size > MAX_WIRING_GUIDE_BYTES) {
      toast.error("Larger than the 25 MB limit.");
      return;
    }
    upload.mutate(file, {
      onSuccess: (result) => (result.duplicate ? toast.info(result.message ?? "This workbook is already imported.") : toast.success("Wiring guide accepted — importing")),
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  // The tracker is a file download, not JSON, so it bypasses apiFetch: fetch the
  // blob, then hand it to the browser via a temporary object URL.
  const [downloadingTracker, setDownloadingTracker] = useState(false);
  const handleDownloadTracker = async () => {
    setDownloadingTracker(true);
    try {
      const res = await fetch(apiUrl("/wiresheet/tracker.xlsx"), { headers: { ...(await authHeaders()) } });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `wiresheet-tracker-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("Wiresheet tracker downloaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloadingTracker(false);
    }
  };

  const imports = data?.imports ?? [];

  return (
    <div className="space-y-8">
      <section aria-label="Upload the wiring guide" className="space-y-3">
        <UploadDropzone
          onFiles={handleFiles}
          disabled={upload.isPending}
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          multiple={false}
          title={upload.isPending ? "Uploading…" : "Drop the DRIG vehicle wiring guide (.xlsx) here"}
          hint="Columns: Year, Make, Model, Install Guide 12v, Install Guide Ignition. Linked photos and guides are copied in; Directechs links need a login and are skipped. The new guide replaces the live one when it finishes."
          buttonLabel="Choose workbook"
        />
      </section>

      <section aria-label="Wiring guide imports" className="space-y-3">
        <h2 className="text-lead font-semibold tracking-tight">Imports</h2>
        {isPending ? (
          <Skeleton className="h-28 w-full" />
        ) : error ? (
          <div className="border-destructive rounded-xl border p-4" role="alert">
            <p className="text-body text-destructive font-medium">Couldn&apos;t load the wiring guide imports</p>
            <p className="text-micro text-muted-foreground mt-1">{errorMessage(error)}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : imports.length === 0 ? (
          <p className="text-micro text-muted-foreground">
            No wiring guide imported yet. Until one is, vehicle wiring questions are answered from Wiresheet only.
          </p>
        ) : (
          <ul className="space-y-3">
            {imports.map((item) => (
              <ImportRow key={item.import_id} item={item} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Wiresheet" className="border-border bg-card flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lead font-semibold tracking-tight">Wiresheet data (fallback)</h2>
          <p className="text-micro text-muted-foreground mt-1">
            Used only where the DRIG guide has nothing for a circuit. Download every scraped vehicle&apos;s 12V and ignition wiring as an
            Excel tracker.
          </p>
        </div>
        <Button onClick={handleDownloadTracker} disabled={downloadingTracker} className="shrink-0">
          {downloadingTracker ? <LoaderCircle className="animate-spin" /> : <Download />}
          {downloadingTracker ? "Preparing…" : "Download Excel"}
        </Button>
      </section>
    </div>
  );
}
