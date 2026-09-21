-- ============================================================================
-- 0710  Document ingest state                        PORTABLE: Supabase + RDS
-- ============================================================================
-- ADDITIVE, same rationale as 0700_ingestion_ops.sql. kb_document's
-- sync_state (discovered/fetched/.../live) models the knowledge-publish
-- lifecycle from DATABASE.md section 7, but the upload pipeline also tracks
-- operational state (temp file path, page/failure counts, an error message
-- for the client to poll) that doesn't belong on the portable knowledge
-- table. Kept as a 1:1 side table instead of adding operational columns to
-- kb_document, so kb_document stays exactly as DATABASE.md defines it.
-- ============================================================================

create table if not exists kb_document_ingest_state (
  doc_id              uuid primary key references kb_document(doc_id),
  ingest_status       text not null default 'queued'
                        check (ingest_status in (
                          'queued','processing','rag_processing','rag_completed',
                          'workdrive_uploading','completed','completed_with_errors','failed'
                        )),
  temp_file_path      text,
  page_count          int,
  processed_pages     int,
  failed_pages        int,
  error_message       text,
  workdrive_folder_id text,
  updated_at          timestamptz not null default now()
);
