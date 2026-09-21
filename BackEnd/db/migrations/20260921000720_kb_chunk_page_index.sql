-- ============================================================================
-- 0720  kb_chunk page/chunk index                    PORTABLE: Supabase + RDS
-- ============================================================================
-- ADDITIVE. kb_chunk has page_from/page_to (a range, for multi-page chunks)
-- but no per-page chunk ordinal, so a re-sync/retry can't upsert "chunk 2 of
-- page 5" idempotently the way the old document_chunks(document_id,
-- page_number, chunk_index) unique constraint did. chunk_index fills that
-- gap for single-page paginated ingestion (PDFs); it stays null for sources
-- that don't chunk by page.
-- ============================================================================

alter table kb_chunk add column if not exists chunk_index int;

create unique index if not exists kb_chunk_page_chunk_idx
  on kb_chunk (doc_id, page_from, chunk_index)
  where chunk_index is not null;
