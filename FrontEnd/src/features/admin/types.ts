/**

* Matches the real backend contract (BackEnd/src/controllers/document.controller.js).

* Field names are the backend's snake_case, unmapped, like features/ragSearch.
 */

export type IngestStatus =
  | "queued"
  | "processing"
  | "rag_processing"
  | "rag_completed"
  | "workdrive_uploading"
  | "completed"
  | "completed_with_errors"
  | "failed";

export interface AdminDocument {
  document_id: string;
  title: string;
  status: IngestStatus;
  total_pages: number | null;
  processed_pages: number | null;
  failed_pages: number | null;
  progress_percent: number;
  /** Heading sections: what the answer model reads. */
  parent_chunks: number;
  /** Retrieval chunks: what search matches. */
  child_chunks: number;
  live_version: number;
  /** True once the original PDF is safely in WorkDrive. */
  archived: boolean;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentListResponse {
  documents: AdminDocument[];
  page: number;
  page_size: number;
  /** Total documents in the knowledge base, across every page — not just this response's `documents`. */
  total: number;
  total_pages: number;
}

/** 202 for a new upload, 200 with `duplicate` when identical bytes were already ingested. */
export interface UploadResponse {
  document_id: string;
  job_id?: string;
  status: IngestStatus;
  duplicate?: boolean;
  message?: string;
}

export interface DriveTypeCount {
  total: number;
  /** Not in the knowledge base yet, matched by file name. */
  remaining: number;
}

export type DriveSyncFileStatus = "waiting" | "downloading" | "queued" | "duplicate" | "failed";

export interface DriveSyncFile {
  name: string;
  /** Path of the Drive subfolder it came from; "" for the main folder. */
  folder: string;
  type: string;
  status: DriveSyncFileStatus;
  /** Set once the file is in the knowledge base (queued, or the existing duplicate). */
  document_id: string | null;
  message: string | null;
}

/** One sync that found new or changed files. */
export interface DriveSyncRun {
  id: number;
  started_at: string;
  /** null while it is still importing. */
  finished_at: string | null;
  /** Importable files in the folder at the time. */
  found: number;
  /** New or changed files this sync took on. */
  total: number;
  processed: number;
  queued: number;
  duplicates: number;
  failed: number;
  current: string | null;
  error: string | null;
  /** True when an admin stopped it before every file was taken on. */
  stopped: boolean;
  files: DriveSyncFile[];
}

/** GET /api/documents/sync-drive — also what the sync and scan POSTs return. */
export interface DriveSyncStatus {
  /** Worker jobs from the Drive sync not finished yet; Stop cancels them. */
  pending_jobs: number;
  /** Files a stopped, failed or interrupted sync left to do; the next Sync resumes with them. */
  resumable: number;
  /** Stop was pressed and the sync is winding down. */
  stopping: boolean;
  configured: boolean;
  /** GDRIVE_SYNC_LIMIT: only the first N files are synced. null = whole folder. */
  limit: number | null;
  phase: "idle" | "scanning" | "importing";
  last_error: string | null;
  /** When a sync last ran and found nothing new (such syncs are not kept in `runs`). */
  last_no_change_at: string | null;
  /** Recent syncs that imported something, newest first. */
  runs: DriveSyncRun[];
  last_scan: {
    at: string;
    supported: number;
    in_knowledge_base: number;
    remaining: number;
    by_type: Record<string, DriveTypeCount>;
    skipped: Record<string, number>;
  } | null;
}

export interface RetryResponse {
  document_id: string;
  status: IngestStatus;
  job_id?: string;
  message?: string;
}

const IN_FLIGHT: ReadonlySet<IngestStatus> = new Set(["queued", "processing", "rag_processing", "workdrive_uploading"]);

/** Still being worked on by the worker, so the list should keep polling. */
export const isInFlight = (status: IngestStatus): boolean => IN_FLIGHT.has(status);

/** Must match the backend's multer limit (upload.middleware.js). */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** What the file chooser offers. Must match the backend's supported types (documentTypes.js). */
export const ACCEPTED_FILE_TYPES = [
  "application/pdf",
  ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".docx",
  "image/jpeg",
  ".jpg",
  ".jpeg",
  "image/png",
  ".png",
] as const;

export type UploadableKind = "pdf" | "docx" | "jpg" | "jpeg" | "png";

/** A standalone image upload (no surrounding manual) — described by the vision model, archived, embedded. */
export const isImageKind = (kind: UploadableKind | null): boolean => kind === "jpg" || kind === "jpeg" || kind === "png";

/** By extension, like the backend: browsers report Word files under several MIME types. */
export const kindOfFile = (name: string): UploadableKind | null => {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".jpg")) return "jpg";
  if (lower.endsWith(".jpeg")) return "jpeg";
  if (lower.endsWith(".png")) return "png";
  return null;
};

export const unsupportedFileMessage = (name: string): string =>
  name.toLowerCase().endsWith(".doc")
    ? "Old .doc files aren't supported. Save it as .docx in Word and upload that."
    : "Only PDF, Word (.docx), JPG or PNG files can be uploaded.";

export interface DeleteResponse {
  document_id: string;
  deleted: boolean;
  chunks_deleted: number;
  figures_deleted: number;
  /** Cleanup that failed after the document itself was removed, e.g. the WorkDrive original. */
  warnings?: string[];
}
