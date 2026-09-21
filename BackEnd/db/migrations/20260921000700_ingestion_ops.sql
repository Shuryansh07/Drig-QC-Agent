-- ============================================================================
-- 0700  Ingestion ops                                 PORTABLE: Supabase + RDS
-- ============================================================================
-- ADDITIVE to Plan/DATABASE.md's appendix, not a replacement of it. The
-- retrieval-focused schema there (kb_document / kb_chunk / kb_image) doesn't
-- define a job queue or per-page resumable ingestion state — that's
-- operational plumbing, not knowledge, and DATABASE.md section 11 explicitly
-- allows adding tables this way: "carry org_id; add RLS and policies (or
-- rerun supabase_security.sql)". Rerun db/platform/supabase/*security.sql
-- after this migration.
--
-- These replace the old Prisma-managed `jobs` / `document_pages` tables,
-- adapted to point at kb_document(doc_id) instead of the dropped
-- documents(id), and carrying org_id per INV-8.
-- ============================================================================

create table if not exists ingestion_job (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organization(org_id),
  job_type     text not null,
  doc_id       uuid references kb_document(doc_id),
  page_number  int,
  payload      jsonb,
  status       text not null default 'pending' check (status in ('pending','running','completed','failed')),
  attempts     int  not null default 0,
  max_attempts int  not null default 3,
  run_at       timestamptz not null default now(),
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists ingestion_job_claim on ingestion_job (status, run_at);
create index if not exists ingestion_job_doc   on ingestion_job (doc_id, status);

-- Per-page resumable ingestion state. status: pending | processing | embedding | completed | failed
create table if not exists kb_document_page (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organization(org_id),
  doc_id              uuid not null references kb_document(doc_id),
  page_number         int  not null,
  status              text not null default 'pending',
  retry_count         int  not null default 0,
  last_error          text,
  has_visual          boolean,
  embedding_completed boolean not null default false,
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (doc_id, page_number)
);

create index if not exists kb_document_page_doc    on kb_document_page (doc_id);
create index if not exists kb_document_page_status on kb_document_page (status);
