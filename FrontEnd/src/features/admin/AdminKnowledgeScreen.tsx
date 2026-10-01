import { useState } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, Search, X } from "lucide-react";
import { toast } from "sonner";
import { PageShell } from "@/components/common/PageShell";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api-client";
import { uuid } from "@/lib/uuid";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { useAdminDocuments } from "./api/queries";
import { useDeleteDocument, useRetryDocument, useUploadDocument } from "./api/mutations";
import { UploadDropzone } from "./components/UploadDropzone";
import { DocumentRow } from "./components/DocumentRow";
import { MAX_UPLOAD_BYTES, kindOfFile, unsupportedFileMessage } from "./types";
import { uuid } from "@/lib/uuid";

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
 * here comes from polling GET /api/documents — one page of it at a time, the
 * server does the slicing.
 */
export default function AdminKnowledgeScreen() {
  const [notices, setNotices] = useState<UploadNotice[]>([]);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  // The query only fires 300ms after typing stops, so each keystroke doesn't
  // hit the server — searchInput still updates instantly, for a responsive box.
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const { data, isPending, error, refetch } = useAdminDocuments(page, debouncedSearch);
  const documents = data?.documents;
  const totalPages = data?.total_pages ?? 1;

  // A new search always starts back at page 1 — set the moment the admin types,
  // not once the debounced request lands, so Previous/Next never show a stale page.
  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    setPage(1);
  };
  const upload = useUploadDocument();
  const retry = useRetryDocument();
  const remove = useDeleteDocument();

  const patchNotice = (id: string, patch: Partial<UploadNotice>) =>
    setNotices((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  const dismissNotice = (id: string) => setNotices((prev) => prev.filter((n) => n.id !== id));

  const handleFiles = async (files: File[]) => {
    const items: UploadNotice[] = files.map((file) => ({ id: uuid(), name: file.name, state: "uploading" }));
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

  // Returns the promise so the confirm dialog stays open when the delete is refused.
  // Known up front, from what's already on screen: deleting the only document left on
  // a page past the first would leave this page empty, so step back once it succeeds.
  const handleDelete = (documentId: string) => {
    const emptiesPage = documents?.length === 1 && page > 1;
    return remove.mutateAsync(documentId).then(
      (result) => {
        toast.success("Document deleted");
        for (const warning of result.warnings ?? []) toast.warning(warning);
        if (emptiesPage) setPage(page - 1);
      },
      (err) => {
        toast.error(errorMessage(err));
        throw err;
      },
    );
  };

  const retryingId = retry.isPending ? retry.variables : undefined;
  const deletingId = remove.isPending ? remove.variables : undefined;

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
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lead font-semibold tracking-tight">
              Documents
              {data && data.total > 0 ? <span className="text-muted-foreground ml-2 font-normal">{data.total}</span> : null}
            </h2>

            <div className="relative sm:w-72">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" aria-hidden />
              <Input
                type="search"
                value={searchInput}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search by file name…"
                aria-label="Search documents by file name"
                className="pl-9"
              />
            </div>
          </div>

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
            debouncedSearch ? (
              <EmptyState
                title="No matches"
                body={`No document title contains "${debouncedSearch}".`}
                action={
                  <Button variant="outline" size="sm" onClick={() => handleSearchChange("")}>
                    Clear search
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No manuals yet"
                body="Upload the first PDF above. It will appear here while it is read, split and indexed."
              />
            )
          ) : (
            <>
              <ul className="space-y-3">
                {documents.map((doc) => (
                  <DocumentRow
                    key={doc.document_id}
                    document={doc}
                    onRetry={handleRetry}
                    retrying={retryingId === doc.document_id}
                    onDelete={handleDelete}
                    deleting={deletingId === doc.document_id}
                  />
                ))}
              </ul>

              {totalPages > 1 ? (
                <div className="flex items-center justify-between pt-1">
                  <p className="text-micro text-muted-foreground">
                    Page {page} of {totalPages}
                  </p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                      <ChevronLeft />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page === totalPages}
                      onClick={() => setPage(page + 1)}
                    >
                      Next
                      <ChevronRight />
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </PageShell>
  );
}
