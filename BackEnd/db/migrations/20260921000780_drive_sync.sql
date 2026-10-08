-- ============================================================================
-- 0780  Google Drive sync history                    PORTABLE: Supabase + RDS
-- ============================================================================
-- Server-side record of the Drive sync, so it survives a browser reload or a
-- backend restart and a stopped sync resumes where it left off:
--   drive_sync_run  one row per sync (counts, when it started/finished/stopped)
--   drive_sync_file one row per Drive file ever seen: the ledger a new sync
--                   reads to skip what is already imported and to pick up what
--                   is still waiting, failed or was cancelled by Stop.
-- ============================================================================

create table if not exists drive_sync_run (
  id           bigserial primary key,
  trigger      text not null default 'manual' check (trigger in ('manual','auto')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  found        int  not null default 0,
  total        int  not null default 0,
  processed    int  not null default 0,
  queued       int  not null default 0,
  duplicates   int  not null default 0,
  failed       int  not null default 0,
  current_file text,
  error        text,
  stopped      boolean not null default false
);

create table if not exists drive_sync_file (
  file_id       text primary key,
  name          text not null,
  folder        text not null default '',
  type          text not null,
  modified_time text,
  status        text not null default 'waiting'
                check (status in ('waiting','downloading','queued','duplicate','failed')),
  doc_id        uuid,
  message       text,
  run_id        bigint references drive_sync_run(id) on delete set null,
  seq           int not null default 0,
  updated_at    timestamptz not null default now()
);

create index if not exists drive_sync_file_run    on drive_sync_file (run_id, seq);
create index if not exists drive_sync_file_status on drive_sync_file (status);
create index if not exists drive_sync_file_doc    on drive_sync_file (doc_id) where doc_id is not null;
