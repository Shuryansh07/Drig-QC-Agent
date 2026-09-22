import { FileText, RotateCw, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { isInFlight, kindOfFile, type AdminDocument, type IngestStatus } from "../types";

interface StatusPresentation {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
}

const STATUS: Record<IngestStatus, StatusPresentation> = {
  queued: { label: "Queued", variant: "secondary" },
  processing: { label: "Processing", variant: "secondary" },
  rag_processing: { label: "Reading & indexing", variant: "secondary" },
  workdrive_uploading: { label: "Archiving", variant: "secondary" },
  rag_completed: { label: "Searchable · archive pending", variant: "outline" },
  completed: { label: "Ready", variant: "default" },
  completed_with_errors: { label: "Needs retry", variant: "destructive" },
  failed: { label: "Failed", variant: "destructive" },
};

const RETRYABLE: ReadonlySet<IngestStatus> = new Set(["failed", "completed_with_errors", "rag_completed"]);

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

interface DocumentRowProps {
  document: AdminDocument;
  onRetry: (documentId: string) => void;
  retrying: boolean;
}

export function DocumentRow({ document: doc, onRetry, retrying }: DocumentRowProps) {
  const status = STATUS[doc.status];
  const inFlight = isInFlight(doc.status);
  // A Word file has no pages (the backend tracks it as one unit), so only PDFs show a page count.
  const paged = kindOfFile(doc.title) === "pdf";
  const pages = paged ? (doc.total_pages ?? 0) : 0;

  const details = [
    pages > 0 ? plural(pages, "page") : null,
    doc.parent_chunks > 0 ? plural(doc.parent_chunks, "section") : null,
    doc.child_chunks > 0 ? plural(doc.child_chunks, "chunk") : null,
    doc.live_version > 0 ? `version ${doc.live_version}` : null,
    `uploaded ${new Date(doc.created_at).toLocaleString()}`,
  ].filter(Boolean);

  return (
    <li className="border-border bg-card rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <FileText className="text-muted-foreground mt-1 size-5 shrink-0" aria-hidden />

        <div className="min-w-0 flex-1 space-y-2">
          {/* Stacked on a phone so a long status label can't squeeze the title into a sliver. */}
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
            <p className="text-body min-w-0 font-medium break-words">{doc.title}</p>
            <Badge variant={status.variant} className="text-micro shrink-0">
              {status.label}
            </Badge>
          </div>

          <p className="text-micro text-muted-foreground">{details.join(" · ")}</p>

          {inFlight ? (
            <div className="space-y-1.5">
              <Progress value={doc.status === "queued" ? 0 : doc.progress_percent} aria-label={`${doc.title} progress`} />
              <p className="text-micro text-muted-foreground">
                {doc.status === "queued"
                  ? "Waiting for the background worker to pick this up."
                  : doc.status === "workdrive_uploading"
                    ? "Archiving the original to WorkDrive."
                    : pages > 0
                      ? `${(doc.processed_pages ?? 0).toLocaleString()} of ${pages.toLocaleString()} pages done`
                      : "Reading the PDF."}
              </p>
            </div>
          ) : null}

          {doc.error_message && !inFlight ? (
            // A searchable document with only the archive outstanding is a note, not an error.
            <p
              className={
                doc.status === "rag_completed"
                  ? "text-micro text-muted-foreground flex items-start gap-1.5"
                  : "text-micro text-destructive flex items-start gap-1.5"
              }
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{doc.error_message}</span>
            </p>
          ) : null}

          {RETRYABLE.has(doc.status) ? (
            <Button variant="outline" size="sm" disabled={retrying} onClick={() => onRetry(doc.document_id)}>
              <RotateCw className={retrying ? "animate-spin" : undefined} />
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
