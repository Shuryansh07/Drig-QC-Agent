-- ============================================================================
-- 0840  DRIG Standard: preferred manuals + the DRIG vehicle wiring guide   PORTABLE
-- ============================================================================
-- DRIG's own documentation always wins over everything else we hold:
--
--   * Manuals. kb_document.collection = 'drig' marks a DRIG Standard manual.
--     Retrieval searches those first and only falls back to the other manuals
--     when no DRIG manual answers the question (ragRetrieval.service.js). It is
--     a column, not a separate kb_source, so a manual already uploaded as an
--     ordinary one can be promoted without re-ingesting it.
--
--   * Wiring. DRIG's "Vehicle wiring guide" workbook is imported into the
--     drig_wiring_* tables below, its linked photos/guides copied into the
--     drig-qc-wiresheet S3 bucket. The chat looks a vehicle up here first and
--     only falls back to the scraped Wiresheet data (0810) for a circuit DRIG
--     has nothing usable for (blank cell, login-only or broken link). Never
--     merged with wiresheet_* or wiring_entry: each source stays labelled.
--
-- Same storage rule as 0810: object KEYS only, never URLs or bucket names.
-- Grants: drig_app is covered by the ALTER DEFAULT PRIVILEGES in 0500.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Manuals
-- ---------------------------------------------------------------------------
alter table kb_document add column if not exists collection text not null default 'general';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'kb_document_collection_check') then
    alter table kb_document add constraint kb_document_collection_check check (collection in ('general', 'drig'));
  end if;
end $$;

create index if not exists kb_document_collection on kb_document (org_id, collection)
  where status = 'current' and live_version > 0;

-- ---------------------------------------------------------------------------
-- Wiring guide: one row per uploaded workbook
-- ---------------------------------------------------------------------------
-- Only one import is live at a time; a new upload is built beside the live one
-- and swapped in atomically when it finishes (publish in drigWiring.ts), so a
-- half-imported guide is never served.
create table if not exists drig_wiring_import (
  import_id    uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organization(org_id),
  file_name    text not null,
  content_hash text not null,                 -- sha256 of the workbook bytes
  s3_key       text not null,                 -- the original workbook, in the DRIG wiring bucket
  status       text not null default 'queued'
                 check (status in ('queued','processing','completed','completed_with_errors','failed')),
  stage        text,                          -- parsing | fetching links | reading photos | publishing
  counts       jsonb not null default '{}',   -- progress + outcome counters for the admin panel
  error        text,
  is_live      boolean not null default false,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

create unique index if not exists drig_wiring_import_one_live on drig_wiring_import (org_id) where is_live;
create index if not exists drig_wiring_import_recent on drig_wiring_import (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Stored files (photos and guides), keyed by content so a photo used on 40
-- rows is stored, and read by the OCR model, exactly once.
-- ---------------------------------------------------------------------------
create table if not exists drig_wiring_asset (
  asset_id      uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organization(org_id),
  content_hash  text not null,
  kind          text not null check (kind in ('image','pdf')),
  mime_type     text not null,
  s3_key        text not null,                -- img/<sha256>.<ext> | doc/<sha256>.pdf
  preview_key   text,                         -- what the chat shows: a ~1280px JPEG (image) or page 1 (pdf)
  thumb_key     text,                         -- ~320px JPEG for lists
  width         int,
  height        int,
  bytes         int,
  page_count    int,                          -- pdf only
  text_layer    text,                         -- pdf only: the document's own text, capped
  -- OCR of the preview by the wiring OCR model (gpt-5 by default). Done once,
  -- at import, never in the chat path. ocr_text is a VERBATIM transcription;
  -- it is shown with the photo and the "confirm on the photo" warning.
  ocr_status    text not null default 'pending'
                  check (ocr_status in ('pending','done','no_text','failed','skipped')),
  ocr_text      text,
  ocr_json      jsonb,
  ocr_model     text,
  ocr_error     text,
  ocr_at        timestamptz,
  created_at    timestamptz not null default now(),
  unique (org_id, content_hash)
);

create index if not exists drig_wiring_asset_ocr_pending on drig_wiring_asset (org_id) where ocr_status = 'pending';

-- Every distinct link the workbook contains, and what happened when we
-- followed it. Kept across imports: re-uploading the guide does not download
-- a link that is already stored. A failed link is retried on the next import.
create table if not exists drig_wiring_link (
  org_id      uuid not null references organization(org_id),
  source_url  text not null,                  -- as written in the workbook (trimmed)
  link_kind   text not null,                  -- image | google_drive | google_doc | google_slides | directechs | wiresheet_icon | other
  status      text not null
                check (status in ('stored','requires_login','icon','unsupported','failed')),
  asset_id    uuid references drig_wiring_asset(asset_id) on delete set null,
  error       text,
  attempts    int not null default 1,
  fetched_at  timestamptz not null default now(),
  primary key (org_id, source_url)
);

-- ---------------------------------------------------------------------------
-- Vehicles and their 12V / ignition cells
-- ---------------------------------------------------------------------------
-- One row per workbook row (year x make x model). model_raw keeps the sheet's
-- text ("ILX PTS"); model / start_type are parsed from it ("ILX", 'pts').
-- start_type null = the sheet does not split this model by start type, so the
-- row applies to both. make_keys holds the normalised make names the row
-- answers to ("Dodge/Ram" -> {dodge, ram}).
create table if not exists drig_wiring_vehicle (
  vehicle_id       uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organization(org_id),
  import_id        uuid not null references drig_wiring_import(import_id) on delete cascade,
  source_row       int  not null,             -- workbook row number, for the citation
  year             int  not null,
  make_raw         text not null,
  make_keys        text[] not null,
  model_raw        text not null,
  model            text not null,
  model_key        text not null,             -- lowercase letters/digits only: "C/V" -> "cv"
  start_type       text check (start_type in ('pts','key')),
  requires_login   boolean not null default false,   -- the sheet's own "Requires Login" mark
  needs_download   boolean not null default false,   -- the sheet's own "Need to download then upload" mark
  unique (import_id, source_row)
);

create index if not exists drig_wiring_vehicle_lookup on drig_wiring_vehicle (import_id, model_key, year);
create index if not exists drig_wiring_vehicle_make on drig_wiring_vehicle using gin (make_keys);

create table if not exists drig_wiring_entry (
  entry_id    uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references drig_wiring_vehicle(vehicle_id) on delete cascade,
  circuit     text not null check (circuit in ('12v','ignition')),
  -- text:  the cell itself is the wiring ("Green 32 pin 02 Blue (+) Driver underdash fusebox")
  -- link:  the cell is a label ("CSX 12V") over a link to a photo or guide
  -- icon:  a pasted Wiresheet icon or similar, no information
  -- empty: blank
  cell_kind   text not null check (cell_kind in ('text','link','icon','empty')),
  cell_text   text,                           -- verbatim cell text
  link_url    text,
  unique (vehicle_id, circuit)
);

create index if not exists drig_wiring_entry_link on drig_wiring_entry (link_url) where link_url is not null;
