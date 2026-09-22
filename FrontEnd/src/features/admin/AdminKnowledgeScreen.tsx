import { useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import { toast } from "sonner";
import { PageShell } from "@/components/common/PageShell";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api-client";
import { useAdminDocuments } from "./api/queries";
import { useRetryDocument, useUploadDocument } from "./api/mutations";
import { UploadDropzone } from "./components/UploadDropzone";
import { DocumentRow } from "./components/DocumentRow";
import { MAX_UPLOAD_BYTES, kindOfFile, unsupportedFileMessage } from "./types";

/** A file the admin just chose, before it shows up in the server's document list. */
interface UploadNotice {
  id: string;
  name: string;
  state: "uploading" | "duplicate" | "error";
  message?: string;
}

const errorMessage = (err: unknown): string =>
  err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Upload failed";

/**
 * Knowledge-base admin: upload manuals, watch them get parsed into sections
 * and chunks, retry failures. The upload returns immediately; a background
 * worker does the parsing, chunking, embedding and publishing, so progress
 * here comes from polling GET /api/documents.
 */
export default function AdminKnowledgeScreen() {
  const [notices, setNotices] = useState<UploadNotice[]>([]);
  const { data: documents, isPending, error, refetch } = useAdminDocuments();
  const upload = useUploadDocument();
  const retry = useRetryDocument();

  const patchNotice = (id: string, patch: Partial<UploadNotice>) =>
    setNotices((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  const dismissNotice = (id: string) => setNotices((prev) => prev.filter((n) => n.id !== id));

  const handleFiles = async (files: File[]) => {
    const items: UploadNotice[] = files.map((file) => ({ id: crypto.randomUUID(), name: file.name, state: "uploading" }));
    setNotices((prev) => [...items, ...prev]);

    // One at a time: the API already queues the heavy work, and sequential
    // requests keep a big batch from saturating the connection.
    for (const [index, file] of files.entries()) {
      const id = items[index].id;

      if (!kindOfFile(file.name)) {
        patchNotice(id, { state: "error", message: unsupportedFileMessage(file.name) });
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        patchNotice(id, { state: "error", message: "Larger than the 500 MB limit." });
        continue;
      }

      try {
        const result = await upload.mutateAsync(file);
        if (result.duplicate) {
          patchNotice(id, { state: "duplicate", message: "This exact file was already ingested — nothing to do." });
        } else {
          // Accepted: it now appears in the document list below, with live progress.
          dismissNotice(id);
        }
      } catch (err) {
        patchNotice(id, { state: "error", message: errorMessage(err) });
      }
    }
  };

  const handleRetry = (documentId: string) => {
    retry.mutate(documentId, {
      onSuccess: (result) => toast.success(result.message ?? "Retry queued"),
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  const retryingId = retry.isPending ? retry.variables : undefined;

  return (
    <PageShell
      wide
      header={
        <div className="px-5 py-4">
          <h1 className="text-title font-semibold tracking-tight">Knowledge base</h1>
          <p className="text-micro text-muted-foreground mt-1">
            Upload manuals and guides (PDF or Word). Each file is split by section and paragraph so the assistant can
            find the right procedure and show it with its warnings.
          </p>
        </div>
      }
    >
      <div className="space-y-8">
        <section aria-label="Upload" className="space-y-3">
          <UploadDropzone onFiles={handleFiles} />

          {notices.length > 0 ? (
            <ul className="space-y-2">
              {notices.map((notice) => (
                <li
                  key={notice.id}
                  className="border-border bg-card flex items-start gap-3 rounded-lg border px-4 py-3"
                  role={notice.state === "error" ? "alert" : undefined}
                >
                  {notice.state === "uploading" ? (
                    <LoaderCircle className="text-muted-foreground mt-0.5 size-5 shrink-0 animate-spin" aria-hidden />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-medium break-words">{notice.name}</p>
                    <p
                      className={
                        notice.state === "error" ? "text-micro text-destructive" : "text-micro text-muted-foreground"
                      }
                    >
                      {notice.state === "uploading" ? "Uploading…" : notice.message}
                    </p>
                  </div>
                  {notice.state !== "uploading" ? (
                    <Button variant="ghost" size="icon-sm" onClick={() => dismissNotice(notice.id)} aria-label="Dismiss">
                      <X />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section aria-label="Documents" className="space-y-3">
          <h2 className="text-lead font-semibold tracking-tight">
            Documents
            {documents && documents.length > 0 ? (
              <span className="text-muted-foreground ml-2 font-normal">{documents.length}</span>
            ) : null}
          </h2>

          {isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : error ? (
            <div className="border-destructive rounded-xl border p-4" role="alert">
              <p className="text-body text-destructive font-medium">Couldn&apos;t load documents</p>
              <p className="text-micro text-muted-foreground mt-1">{errorMessage(error)}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
                Try again
              </Button>
            </div>
          ) : !documents || documents.length === 0 ? (
            <EmptyState
              title="No manuals yet"
              body="Upload the first PDF above. It will appear here while it is read, split and indexed."
            />
          ) : (
            <ul className="space-y-3">
              {documents.map((doc) => (
                <DocumentRow
                  key={doc.document_id}
                  document={doc}
                  onRetry={handleRetry}
                  retrying={retryingId === doc.document_id}
                />
              ))}
            </ul>
          )}

          <p className="text-micro text-muted-foreground pt-2">
            Processing runs in the background worker (<code>npm run worker</code> in BackEnd). If a document stays
            &ldquo;Queued&rdquo;, the worker isn&apos;t running.
          </p>
        </section>
      </div>
    </PageShell>
  );
}
