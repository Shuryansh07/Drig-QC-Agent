-- ============================================================================
-- 0770  Cancellable ingestion jobs                   PORTABLE: Supabase + RDS
-- ============================================================================
-- Lets an operator stop ingestion (the Drive sync's Stop button): a pending job
-- is never claimed, and a running job is noticed by its worker at the next
-- checkpoint. Adds 'cancelled' to ingestion_job.status.
-- ============================================================================

alter table ingestion_job drop constraint if exists ingestion_job_status_check;
alter table ingestion_job
  add constraint ingestion_job_status_check
  check (status in ('pending','running','completed','failed','cancelled'));

-- Jobs started by the Drive sync carry payload {"source":"drive-sync"}; Stop finds them by it.
create index if not exists ingestion_job_source
  on ingestion_job ((payload->>'source'))
  where status in ('pending','running');
