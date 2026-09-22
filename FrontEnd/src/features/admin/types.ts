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
}

/** 202 for a new upload, 200 with `duplicate` when identical bytes were already ingested. */
export interface UploadResponse {
  document_id: string;
  job_id?: string;
  status: IngestStatus;
  duplicate?: boolean;
  message?: string;
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
] as const;

export type UploadableKind = "pdf" | "docx";

/** By extension, like the backend: browsers report Word files under several MIME types. */
export const kindOfFile = (name: string): UploadableKind | null => {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  return null;
};

export const unsupportedFileMessage = (name: string): string =>
  name.toLowerCase().endsWith(".doc")
    ? "Old .doc files aren't supported. Save it as .docx in Word and upload that."
    : "Only PDF and Word (.docx) files can be uploaded.";
