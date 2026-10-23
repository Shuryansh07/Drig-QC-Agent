-- ============================================================================
-- 0810  Wiresheet: scraped vehicle wiring data + scrape progress   PORTABLE
-- ============================================================================
-- Wiresheet is a lower-trust SUPPLEMENT to the DRIG wiring guide, never merged
-- into wiring_entry (Plan/WIRESHEET_SCRAPING_PLAN.md §1, Todd Q2/Q3). DRIG
-- always wins; anything served from here is labelled as Wiresheet.
--
-- These tables are both the scraper's OUTPUT and its RESUME STATE. The scraper
-- runs on Fargate, whose local disk is wiped when the task exits, so the old
-- done.json / vehicles.jsonl / uploaded-images.json files could not survive a
-- restart. Everything that used to live in those files is a row here instead:
--   wiresheet_scrape_combo  <- done.json           (which make/year/model combos are finished)
--   wiresheet_vehicle       <- vehicles.jsonl       (one row per scraped make/year/model/recnum)
--   wiresheet_entry         <- vehicles.jsonl .wires (the 12V / ignition wires kept per vehicle)
--   wiresheet_image         <- uploaded-images.json  (one row per distinct photo, by content hash)
--   wiresheet_image_source  <- uploaded-images.json  (source URL -> image, so a URL is fetched once)
--
-- A resumed or weekly run reads wiresheet_scrape_combo to skip finished combos
-- and wiresheet_vehicle to skip vehicles already recorded, exactly as the JSON
-- files used to be read. Photos go to the qc-wiresheet S3 bucket; only the
-- object KEY is stored (DATABASE.md: "store object keys only, never full URLs
-- or bucket names"), served to the app as a short-lived signed URL.
--
-- Grants: drig_app is covered by the ALTER DEFAULT PRIVILEGES in 0500, so the
-- scraper (connecting as drig_app) can read/write these with no extra grant.
-- ============================================================================

-- Progress ledger: which make/year/model combos are done, and why a combo has
-- no vehicles (no years / no models / no key types). Replaces done.json.
-- year/model are '' (not null) at the combo levels that have no year or no
-- model — primary-key columns cannot be null, and '' is a value ON CONFLICT
-- can match so re-marking a combo is an upsert, not a duplicate-key error.
create table if not exists wiresheet_scrape_combo (
  org_id     uuid not null references organization(org_id),
  make       text not null,
  year       text not null default '',     -- '' for a make with no years at all
  model      text not null default '',     -- '' for a year with no models
  state      text not null default 'done'
               check (state in ('done','no_years','no_models','no_keys')),
  updated_at timestamptz not null default now(),
  primary key (org_id, make, year, model)
);

-- One row per scraped vehicle (make/year/model/recnum). Lossless mirror of a
-- vehicles.jsonl line, status and all: 'ok', 'no wire table', 'no key types',
-- 'error'. year is kept as text because it comes verbatim from the site.
create table if not exists wiresheet_vehicle (
  vehicle_id     uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organization(org_id),
  make           text not null,
  year           text not null,
  model          text not null,
  recnum         text,                      -- Wiresheet's own profile/vehicle id; null only for combo-level bookkeeping rows
  key_type       text,                      -- Wiresheet's own key-type text, verbatim ("Push To Start")
  title          text,                      -- page heading, e.g. "2026 Acura ADX - Push To Start (VIN 10th Digit: T)"
  status         text not null,             -- ok | no wire table | no key types | error
  found_12v       boolean not null default false,
  photo_12v       boolean not null default false,
  found_ignition  boolean not null default false,
  photo_ignition  boolean not null default false,
  error_message  text,
  scraped_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, make, year, model, recnum)
);

-- Photos, keyed by content hash so the same picture shown on many vehicles is
-- stored once. s3_key / thumb_key ONLY, never a URL (served as a signed URL,
-- same pattern as kb_image.s3_key).
create table if not exists wiresheet_image (
  image_id     uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organization(org_id),
  content_hash text not null,
  s3_key       text not null,              -- img/<sha256>.<ext>   (in the qc-wiresheet bucket)
  thumb_key    text,                       -- thumb/<sha256>.jpg
  width        int,
  height       int,
  created_at   timestamptz not null default now(),
  unique (org_id, content_hash)
);

-- Which Wiresheet-hosted URL produced which stored photo. Lets a resumed run
-- skip re-downloading a URL it already has (different URLs can share bytes, so
-- several rows may point at one image). Replaces uploaded-images.json's URL map.
create table if not exists wiresheet_image_source (
  org_id     uuid not null references organization(org_id),
  source_url text not null,
  image_id   uuid not null references wiresheet_image(image_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (org_id, source_url)
);

-- The 12V / ignition wires kept for a vehicle (one row per wire). cell_raw is
-- the verbatim row text; the parsed columns are a convenience on top of it.
-- Each wire links to at most one photo (image_id), the picture on its page.
create table if not exists wiresheet_entry (
  entry_id      uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organization(org_id),
  vehicle_id    uuid not null references wiresheet_vehicle(vehicle_id) on delete cascade,
  ordinal       int  not null default 1,     -- position within the vehicle's wire list (two 12V rows -> 1 and 2, Todd Q13)
  circuit       text not null check (circuit in ('12v','ignition','other')),  -- 'other' only appears under --all-wires
  section       text,                        -- page section (Power & Ground, Remote Start Control, Security Status, ...)
  function_name text,                        -- Wiresheet's own wire label, verbatim ("Constant +12 Volts (2)")
  wire_colour   text,
  polarity      text,
  location      text,
  notes         text,
  cell_raw      text not null,
  image_id      uuid references wiresheet_image(image_id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists wiresheet_vehicle_lookup on wiresheet_vehicle (org_id, lower(make), lower(model), year);
create index if not exists wiresheet_vehicle_recnum on wiresheet_vehicle (org_id, recnum) where recnum is not null;
create index if not exists wiresheet_entry_vehicle on wiresheet_entry (vehicle_id);
