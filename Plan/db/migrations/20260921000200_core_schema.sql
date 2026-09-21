-- ============================================================================
-- 0200  Core schema                                  PORTABLE: Supabase + RDS
-- ============================================================================
-- Rules that shape every table below:
--   INV-4  Tunables are rows in `setting`, never constants in code.
--   INV-7  Soft delete only. Chunks and documents are never hard-deleted,
--          because old conversations cite them and those citations must resolve.
--   INV-8  Core rows carry org_id (and workflow_id where it applies), even
--          though Phase 1 has exactly one of each.
--   No foreign keys into Supabase's `auth` schema. Identity is `person.external_ref`,
--   which is a Supabase Auth user id today and a Cognito `sub` after migration.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tenancy, people, permissions
-- ---------------------------------------------------------------------------
create table if not exists organization (
  org_id      uuid primary key default gen_random_uuid(),
  name        text not null unique,          -- unique keeps the seed idempotent
  created_at  timestamptz not null default now()
);

create table if not exists workflow (
  workflow_id uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organization(org_id),
  code        text not null,                 -- 'qc_support'
  name        text not null,
  unique (org_id, code)
);

create table if not exists app_role (
  role_id uuid primary key default gen_random_uuid(),
  org_id  uuid not null references organization(org_id),
  code    text not null,                     -- technician | engineer | manager | admin
  name    text not null,
  unique (org_id, code)
);

create table if not exists permission (
  permission_id uuid primary key default gen_random_uuid(),
  code          text not null unique,        -- 'knowledge.upload'
  description   text
);

create table if not exists app_role_permission (
  role_id       uuid not null references app_role(role_id),
  permission_id uuid not null references permission(permission_id),
  primary key (role_id, permission_id)
);

create table if not exists person (
  person_id     uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organization(org_id),
  auth_provider text not null default 'supabase'
                  check (auth_provider in ('supabase','cognito')),
  external_ref  text not null,               -- JWT `sub` from the auth provider
  display_name  text not null,
  email         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (org_id, auth_provider, external_ref)
);

create table if not exists person_role (
  person_id uuid not null references person(person_id),
  role_id   uuid not null references app_role(role_id),
  primary key (person_id, role_id)
);

create table if not exists setting (
  setting_id  uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organization(org_id),
  workflow_id uuid not null references workflow(workflow_id),
  key         text not null,
  value_json  jsonb not null,
  description text,
  version     int not null default 1,
  updated_at  timestamptz not null default now(),
  unique (org_id, workflow_id, key)
);

-- ---------------------------------------------------------------------------
-- Knowledge base: sources, documents, chunks, images
-- ---------------------------------------------------------------------------
create table if not exists kb_source (
  source_id    uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organization(org_id),
  type         text not null
                 check (type in ('manual','wiring','call','web','schematic','upload')),
  name         text not null,
  config_json  jsonb not null default '{}',   -- folder id, sheet id, cadence ...
  last_sync_at timestamptz,
  status       text not null default 'active',
  unique (org_id, name)
);

create table if not exists kb_document (
  doc_id            uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organization(org_id),
  source_id         uuid not null references kb_source(source_id),
  external_ref      text not null,           -- WorkDrive / Drive file id
  title             text not null,
  vendor            text,
  product_family    text,
  models            text[] not null default '{}',
  language          text not null default 'en',
  s3_key            text,                    -- key only; bucket comes from config
  content_hash      text,
  live_version      int not null default 0,  -- 0 = never published
  -- supersede chain: only 'current' documents are ever searchable
  status            text not null default 'current'
                      check (status in ('current','superseded','archived')),
  effective_date    date,
  supersedes_doc_id uuid references kb_document(doc_id),
  origin            text not null default 'sync' check (origin in ('sync','upload')),
  uploaded_by       uuid references person(person_id),
  sync_state        text not null default 'discovered'
                      check (sync_state in ('discovered','fetched','normalized','chunked',
                                            'embedded','indexed','live','failed','unchanged')),
  last_error        text,
  synced_at         timestamptz,
  created_at        timestamptz not null default now(),
  unique (org_id, source_id, external_ref)
);

create table if not exists kb_chunk (
  chunk_id        uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organization(org_id),
  doc_id          uuid not null references kb_document(doc_id),
  parent_chunk_id uuid references kb_chunk(chunk_id),  -- child matches, parent is sent to the model
  version         int  not null default 1,
  text            text not null,
  text_hash       text not null,             -- lets a re-sync reuse unchanged vectors
  embedding       extensions.vector(1536),
  -- denormalised from kb_document so the hot query needs no join
  source_type     text not null,
  vendor          text,
  product_family  text,
  models          text[] not null default '{}',
  language        text not null default 'en',
  section_path    text,                      -- "4. Installation > 4.3 Power"
  page_from       int,
  page_to         int,
  metadata        jsonb not null default '{}',
  -- is_live is maintained ONLY by publish_document_version / retire_document.
  -- It is in the partial-index predicate, which keeps dead rows out of the graph.
  is_live         boolean not null default false,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now(),
  text_search     tsvector generated always as (to_tsvector('english', text)) stored
);

create table if not exists kb_image (
  image_id          uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organization(org_id),
  doc_id            uuid not null references kb_document(doc_id),
  chunk_id          uuid references kb_chunk(chunk_id),
  version           int  not null default 1,
  page              int,
  bbox              jsonb,
  s3_key            text not null,
  thumb_key         text,
  image_type        text not null default 'diagram'
                      check (image_type in ('diagram','photo','screenshot','table_scan','decorative')),
  caption           text,                    -- from the document: may be cited
  surrounding       text,                    -- from the document: may be cited
  description       text,                    -- MODEL-GENERATED: search aid only, never cited, never shown as fact
  description_model text,
  embedding         extensions.vector(1536), -- of caption + surrounding + description
  ocr_text          text,
  ocr_confidence    real,
  is_citable        boolean not null default false,
  is_live           boolean not null default false,
  deleted_at        timestamptz
);

-- ---------------------------------------------------------------------------
-- Wiring guide. INV-2: looked up with SQL, NEVER by vector similarity.
-- One sheet row becomes two wiring_entry rows (12v + ignition). start_type is
-- parsed out of the model string ("TL PTS" -> model TL, start_type pts).
-- cell_raw is always kept: it is what the technician sees and what Gate 6
-- checks literals against.
-- ---------------------------------------------------------------------------
create table if not exists wiring_entry (
  entry_id         uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organization(org_id),
  sheet_version    int  not null,
  row_key          text not null,            -- stable identity across sheet edits
  source_row       int,                      -- sheet row number, for the citation
  year             int  not null,
  make             text not null,
  model_raw        text not null,
  model            text not null,
  start_type       text check (start_type in ('pts','key')),
  circuit          text not null check (circuit in ('12v','ignition')),
  cell_kind        text not null check (cell_kind in ('inline','doc_ref')),
  cell_raw         text not null,
  -- parsed; only when cell_kind = 'inline'
  wire_colour      text,
  fuse_rating      text,
  component        text,
  location         text,
  connector_colour text,
  connector_pins   int,
  plug_label       text,
  pin              int,
  parse_confidence real,
  -- only when cell_kind = 'doc_ref' (the sheet also indexes install guides)
  doc_ref_label    text,
  doc_ref_url      text,
  doc_id           uuid references kb_document(doc_id),
  requires_login   boolean not null default false,
  manual_upload    boolean not null default false,
  notes            text,
  notes_vec        extensions.vector(1536),  -- the notes column ONLY, never the row
  -- source validation. validation_notes holds one key per failed rule
  -- (V1..V7); validation_state is derived from it by run_wiring_validation.
  validation_notes jsonb not null default '{}',
  validation_state text  not null default 'ok'
                     check (validation_state in ('ok','flagged','quarantined')),
  is_live          boolean not null default false,
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  unique (org_id, sheet_version, row_key, circuit)
);

-- Rows that could not be parsed into wiring_entry at all (no year, no make).
-- Never silently dropped: they surface on the dashboard for the sheet owner.
create table if not exists wiring_quarantine (
  quarantine_id uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organization(org_id),
  sheet_version int  not null,
  source_row    int,
  raw_row       jsonb not null,
  reasons       text[] not null,
  resolved      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Call knowledge. Raw transcripts are never indexed; reviewed cards are.
-- Symptom and resolution are embedded separately: a technician describes a
-- symptom, so their question is matched against stored symptoms.
-- ---------------------------------------------------------------------------
create table if not exists call_recording (
  call_id      uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organization(org_id),
  external_ref text not null,
  s3_key       text,
  duration_s   int,
  recorded_at  timestamptz,
  state        text not null default 'exported',
  last_error   text,
  unique (org_id, external_ref)
);

create table if not exists call_card (
  card_id         uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organization(org_id),
  call_id         uuid not null references call_recording(call_id),
  timestamp_range text,
  symptom         text not null,
  symptom_vec     extensions.vector(1536),
  context_json    jsonb not null default '{}',
  diagnostic_path jsonb,
  root_cause      text,
  resolution      jsonb,
  resolution_vec  extensions.vector(1536),
  -- 'unverified' is presented as an unconfirmed similar case, never as instruction
  confidence      text not null default 'unverified'
                    check (confidence in ('confirmed','probable','unverified')),
  review_status   text not null default 'draft'
                    check (review_status in ('draft','in_review','approved','rejected','indexed')),
  is_live         boolean not null default false,  -- trigger enforces INV-6
  deleted_at      timestamptz,
  created_at      timestamptz not null default now()
);

-- INV-6: nothing curated goes live without a row here.
create table if not exists review_action (
  action_id   uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organization(org_id),
  entity_type text not null,                 -- 'call_card' | 'kb_document' | 'wiring_entry'
  entity_id   uuid not null,
  action      text not null check (action in ('approve','edit','reject')),
  reason      text,
  reviewer_id uuid references person(person_id),
  created_at  timestamptz not null default now()
);

create table if not exists kb_conflict (
  conflict_id uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organization(org_id),
  chunk_id_a  uuid not null references kb_chunk(chunk_id),
  chunk_id_b  uuid not null references kb_chunk(chunk_id),
  kind        text not null,                 -- 'wire_colour' | 'torque' | 'part_number' ...
  detail      jsonb,
  status      text not null default 'open',
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Conversation
-- ---------------------------------------------------------------------------
create table if not exists chat_session (
  session_id    uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organization(org_id),
  workflow_id   uuid not null references workflow(workflow_id),
  person_id     uuid not null references person(person_id),
  channel       text not null default 'text' check (channel in ('text','voice')),
  frame_json    jsonb,                       -- working memory; write-through from cache
  frame_version int not null default 0,      -- optimistic concurrency
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  outcome       text check (outcome in ('resolved','partly','not_resolved','handoff','abandoned'))
);

create table if not exists chat_message (
  message_id   uuid primary key default gen_random_uuid(),
  session_id   uuid not null references chat_session(session_id),
  role         text not null check (role in ('user','assistant','system')),
  content      text,
  frame_json   jsonb,                        -- snapshot AFTER this turn's merge
  gate_outcome text,                         -- answered | clarify | not_covered | conflict | error
  gate_trace   jsonb,                        -- every gate decision, with reasons
  latency_ms   int,
  created_at   timestamptz not null default now()
);

create table if not exists turn_retrieval (
  id               uuid primary key default gen_random_uuid(),
  message_id       uuid not null references chat_message(message_id),
  chunk_id         uuid references kb_chunk(chunk_id),
  card_id          uuid references call_card(card_id),
  wiring_entry_id  uuid references wiring_entry(entry_id),
  dense_rank       int,
  lexical_rank     int,
  dense_similarity real,
  score            real,
  used_in_answer   boolean not null default false
);

create table if not exists citation (
  citation_id  uuid primary key default gen_random_uuid(),
  message_id   uuid not null references chat_message(message_id),
  step_n       int,
  chunk_id     uuid references kb_chunk(chunk_id),
  card_id      uuid references call_card(card_id),
  wiring_entry_id uuid references wiring_entry(entry_id),
  resolved_ref text                          -- "ECCO 5500 manual, p.3"
);

create table if not exists handoff (
  handoff_id      uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organization(org_id),
  session_id      uuid not null references chat_session(session_id),
  engineer_id     uuid references person(person_id),
  opened_at       timestamptz not null default now(),
  closed_at       timestamptz,
  resolution_text text
);

create table if not exists feedback (
  feedback_id uuid primary key default gen_random_uuid(),
  message_id  uuid not null references chat_message(message_id),
  rating      text not null check (rating in ('up','down')),
  comment     text,
  created_at  timestamptz not null default now()
);

-- The improvement loop. Every refusal, handoff and thumbs-down writes one.
create table if not exists kb_gap (
  gap_id        uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organization(org_id),
  workflow_id   uuid not null references workflow(workflow_id),
  query_text    text not null,
  query_vec     extensions.vector(1536),
  frame_json    jsonb,
  retrieved_ids uuid[],
  reason        text not null
                  check (reason in ('not_covered','handoff','negative_feedback','conflict','quarantined')),
  session_id    uuid references chat_session(session_id),
  cluster_id    uuid,
  status        text not null default 'open' check (status in ('open','resolved','wont_fix')),
  created_at    timestamptz not null default now()
);

create table if not exists event_log (
  event_id    bigint generated always as identity primary key,
  org_id      uuid not null references organization(org_id),
  workflow_id uuid references workflow(workflow_id),
  actor_id    uuid references person(person_id),
  event_type  text not null,                 -- 'document.uploaded', 'card.approved' ...
  payload     jsonb,
  ts          timestamptz not null default now()
);
