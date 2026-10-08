-- ============================================================================
-- 0790  Drive sync control through the database      PORTABLE: Supabase + RDS
-- ============================================================================
-- More than one backend can share a database (a deployed server and a dev
-- machine, say). A sync's state therefore cannot live only in the memory of the
-- process running it. A running sync now:
--   * beats `heartbeat_at` every few seconds, so another process can tell a live
--     run from one whose process died;
--   * watches `stop_requested`, which Stop sets from ANY backend instance.
-- ============================================================================

alter table drive_sync_run add column if not exists instance_id    text;
alter table drive_sync_run add column if not exists heartbeat_at   timestamptz not null default now();
alter table drive_sync_run add column if not exists stop_requested boolean not null default false;

create index if not exists drive_sync_run_open on drive_sync_run (id) where finished_at is null;
