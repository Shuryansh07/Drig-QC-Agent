# DATABASE.md: DRIG QC Support Agent

**Audience:** Claude Code and the engineers working on this repo.
**Read this before you touch a migration, a query or the data layer.**

The database runs on **Supabase today** and moves to **AWS RDS later**. The
same migrations run on both. This document explains how the schema is shaped,
which rules keep it portable, and which mistakes it is built to prevent. The
full SQL is in the appendix.

**Source of truth:** the files in `db/migrations/` and `db/platform/`. The
appendix copies them verbatim. If the two ever disagree, the migrations are
right and this document gets updated in the same pull request.

---

## 1. Platform plan

| | Supabase (now) | AWS RDS (later) |
|---|---|---|
| Postgres | Managed by Supabase | RDS PostgreSQL 17.1+ |
| pgvector | **0.8.0 or newer** (upgrade the project's Postgres version if lower) | Comes with 17.1+, 16.5+, 15.9+, 14.14+, 13.17+ |
| Migrations | `db/migrations/*` + `db/platform/supabase/*` | `db/migrations/*` + `db/platform/aws/*` |
| App connects as | `drig_app` through the session pooler | `drig_app` with IAM auth |
| Object storage | Supabase Storage through its **S3 protocol** | Amazon S3 |
| Auth | Supabase Auth JWTs, verified via JWKS | Cognito JWTs, verified via JWKS |
| Exposure risk | Data API publishes `public`, so RLS locks it down | No Data API; security groups only |

Everything in `db/migrations/` is identical on both. Only two small files
differ: `supabase_security.sql` (RLS lockout) and `aws_platform.sql`
(IAM grant). The move to AWS is a data copy and an environment-variable
change, not a rewrite. The data layer code stays the same, and so do the queries.

---

## 2. Portability rules

These are what make the move to AWS cheap. Breaking one means rewriting code
at migration time.

**P1. Use a plain Postgres driver for all data access.**
`pg` / `postgres.js` in TypeScript, `psycopg` in Python. **Do not use
`supabase-js` or the PostgREST API (`.from()`, `.rpc()`) for data.** Neither
exists on RDS, so every call written that way gets rewritten at migration.
Supabase is only a Postgres host here.

**P2. No Supabase-only features in the core schema.**
No foreign keys into the `auth` schema. No Realtime, Database Webhooks,
`pg_net`, Edge Functions or Storage tables. Identity is
`person.auth_provider` plus `person.external_ref` (the JWT `sub`).

**P3. Object storage goes through the S3 API.**
Use `@aws-sdk/client-s3` against Supabase's S3 endpoint now and real S3 later.
Store **object keys only** (`s3_key`, `thumb_key`), never full URLs or bucket
names. The bucket and endpoint come from configuration.

**P4. Auth sits behind one interface.**
The backend verifies a JWT against a JWKS URL and maps `sub` to
`person.external_ref`. Swapping providers means changing configuration and
remapping rows (runbook in §10). Route handlers don't change.

**P5. Every vector query goes through a SQL function.**
`match_chunks`, `match_call_cards`, `eval_*`. Application code never writes
`<=>`. Those functions carry the pgvector settings retrieval depends on (§8.1).
A hand-written query skips them silently.

**P6. The app connects as `drig_app` on both platforms.**
Never as `postgres` (Supabase) or `drigadmin` (RDS). The admin user runs
migrations only.

**P7. Schema changes happen only through migration files.**
Never edit tables in the Supabase dashboard. A dashboard edit exists on one
platform only, so it becomes drift that breaks the AWS move.

**P8. Schedules live in the job runner, not the database.**
No `pg_cron`. Sync timing is owned by the application's scheduler (EventBridge
on AWS).

---

## 3. Connecting

### Supabase

| Use | Connection | Notes |
|---|---|---|
| Migrations, `pg_dump`, psql admin | Direct: `db.<ref>.supabase.co:5432` as `postgres` | **IPv6 only** unless the project has the IPv4 add-on |
| Long-running backend (the API server) | **Session pooler:** `aws-<n>-<region>.pooler.supabase.com:5432` | Works over IPv4 on every plan |
| Serverless or edge function | Transaction pooler: same host, port **6543** | No prepared statements (turn them off in the driver); session state does not survive between transactions |

Pooler usernames take the form `<role>.<project-ref>`, so the app user is
`drig_app.<project-ref>`. Confirm this login works in week one.

**Why this matters for vector search:** a `SET hnsw.iterative_scan = ...` run by
the app on the transaction pooler is lost before the next transaction. That is
why the setting is declared on each function instead (§8.1). The functions
behave the same on every connection mode.

### AWS RDS

`drig_app` authenticates with an IAM token (`rds_iam` is granted by
`aws_platform.sql`). Keep the pool at 5–10 connections per API instance. The
database is reachable only from the application security group.

### Environment variables

```
DATABASE_URL            # app role (drig_app). Session pooler on Supabase.
DATABASE_URL_ADMIN      # migrations only. Never loaded by the API process.
S3_ENDPOINT             # https://<ref>.storage.supabase.co/storage/v1/s3  | unset on AWS
S3_REGION               # the Supabase project region | the AWS region
S3_FORCE_PATH_STYLE     # true on Supabase | false on AWS
S3_BUCKET               # drig-kb
S3_ACCESS_KEY_ID        # Supabase S3 keys BYPASS RLS: server-side only, never in the browser
S3_SECRET_ACCESS_KEY
AUTH_PROVIDER           # supabase | cognito
AUTH_JWKS_URL
AUTH_ISSUER
```

---

## 4. What the database enforces

These rules are enforced in the database itself, not just documented. Tests
confirmed each one (§9).

| Rule | How it is enforced |
|---|---|
| pgvector ≥ 0.8.0 | Migration 0100 fails with an upgrade hint |
| Vector search never silently returns too few rows | Every vector function sets `hnsw.iterative_scan`, `ef_search`, `max_scan_tuples` on itself |
| Dead or superseded rows never take search slots | HNSW and full-text indexes are **partial** (`where deleted_at is null and is_live`) |
| Only published, current, embedded chunks are searchable | `is_live` is set only by `publish_document_version`, which refuses missing embeddings or non-current documents |
| A parent chunk can never be matched | `kb_chunk.is_parent` rows are never live and never embedded: a check constraint (`kb_chunk_parent_not_searchable`, migration 0730) enforces it. Parents are read by id through `parent_chunk_id`. `verify.sql` 4b/4c re-check it. |
| Old citations still resolve (INV-7) | Nothing is hard-deleted. Old versions are soft-deleted. Superseded documents stay stored but leave the search index. |
| Wiring is exact-match only (INV-2) | `lookup_wiring` returns exact rows or **zero**, never a nearest model year |
| A known-bad wiring value can't be served | Quarantined rows come back with `cell_raw`, `wire_colour` and `pin` **set to NULL** |
| Nothing curated goes live unreviewed (INV-6) | A trigger blocks `call_card.is_live = true` unless the latest review action is an approval |
| Model-written image text never grounds an answer | `images_for_chunks` does not return `description` at all |
| The browser can't reach data (Supabase) | RLS on every table. `anon` and `authenticated` have no grants on tables, sequences or functions. |
| Tunables are data, not code (INV-4) | `setting` table, seeded in 0600 |
| Every core row carries its tenant (INV-8) | `org_id` on core tables, `workflow_id` where it applies |

---

## 5. Entity map

```
organization ─┬─ workflow ── setting
              ├─ app_role ── app_role_permission ── permission
              ├─ person ──── person_role ── app_role
              │
              ├─ kb_source ── kb_document ─┬─ kb_chunk ─── kb_image
              │                            └─ (supersedes_doc_id → kb_document)
              ├─ wiring_entry   wiring_quarantine
              ├─ call_recording ── call_card        review_action   kb_conflict
              │
              └─ chat_session ─┬─ chat_message ─┬─ turn_retrieval
                               │                ├─ citation
                               │                └─ feedback
                               ├─ handoff
                               └─ kb_gap                     event_log
```

| Group | Table | Holds | Written by | Read by |
|---|---|---|---|---|
| Tenancy | `organization`, `workflow` | DRIG, `qc_support` | seed | everything |
| | `setting` | Thresholds, model ids, regexes, allowlists | seed, admin UI | every gate |
| Access | `app_role`, `permission`, `app_role_permission` | Role → permission matrix | seed, admin UI | API middleware |
| | `person`, `person_role` | People mapped to auth `sub` | admin UI, first login | API middleware |
| Knowledge | `kb_source` | One row per source (a Drive folder, the sheet, …) | admin | sync jobs |
| | `kb_document` | One file. Status, version, supersede chain | sync jobs, upload | publish/retire functions |
| | `kb_chunk` | Text + vector + keyword index. Parent/child. | ingestion | `match_chunks` |
| | `kb_image` | Figures. `caption` citable, `description` never | ingestion | `images_for_chunks` |
| Wiring | `wiring_entry` | One row per vehicle × year × circuit | sheet sync | `lookup_wiring` |
| | `wiring_quarantine` | Rows that couldn't be parsed at all | sheet sync | dashboard |
| Calls | `call_recording`, `call_card` | Audio refs; reviewed symptom→fix cards | call pipeline, reviewers | `match_call_cards` |
| Curation | `review_action` | Approve / edit / reject with reviewer | review UI | trigger, audit |
| | `kb_conflict` | Sources that disagree on a value | conflict job | answer path, dashboard |
| Conversation | `chat_session` | One conversation; `frame_json` = working memory | API | API |
| | `chat_message` | Each turn plus its gate trace | API | API, audit |
| | `turn_retrieval`, `citation` | What was retrieved; what was cited | API | audit, eval |
| | `handoff`, `feedback` | Escalations; thumbs up/down | API | engineer console, dashboard |
| Improvement | `kb_gap` | Every refusal, handoff, thumbs-down | API | weekly gap clustering |
| | `event_log` | Append-only audit trail | everything | audit |

---

## 6. How the application uses it

### 6.1 `match_chunks`: hybrid retrieval

```ts
const { rows } = await pool.query(
  `select * from match_chunks(
     p_org_id          => $1,
     p_query_embedding => $2,
     p_query_text      => $3,
     p_match_count     => $4,
     p_boost_vendor    => $5,
     p_boost_model     => $6)`,
  [orgId, pgvector.toSql(embedding), questionText, 8, frame.vendor, frame.product],
);
```

Runs a vector search and a keyword search, fuses them by rank, then applies
small boosts. Returns `chunk_id, doc_id, parent_chunk_id, dense_rank,
lexical_rank, dense_similarity, score`.

- **Gate 2 thresholds on `dense_similarity`, not `score`.** `score` is a
  rank-fusion number and can't be compared across queries.
  `retrieval.admit_min_similarity` is the starting threshold. Also admit when
  `lexical_rank` is set and the question contained an exact part or model code
  (`retrieval.admit_on_exact_code`).
- **Vendor, model and language are boosts, not filters.** A wrong guess from
  frame extraction lowers a row's rank but never removes it. Only tenant,
  liveness and source type filter.
- **Web snapshots are excluded unless asked for** (`p_source_types => '{web}'`).
- Send the **parent** chunk (`parent_chunk_id`) to the model. The child chunk
  was only the match.
- Log every returned row to `turn_retrieval`. (Not built yet: it needs a
  `chat_message` row, and the backend has no chat sessions until auth exists.)

**Where this is implemented:** `src/services/ragRetrieval.service.js`
(`decideAdmission` is Gate 2; results are de-duplicated by parent). When the
gate refuses, no LLM call is made, the question is written to `kb_gap` with
reason `not_covered`, and the response lists the live document titles.
`POST /api/rag/query/stream` sends this as server-sent events; the one-shot
`POST /api/rag/query` applies the same gate.

### 6.2 `lookup_wiring`: exact vehicle lookup

```ts
const { rows } = await pool.query(
  `select * from lookup_wiring($1, $2, $3, $4, $5, $6)`,
  [orgId, make, model, year, circuit /* or null */, startType /* or null */],
);
```

| Result | Meaning | What the agent does |
|---|---|---|
| 0 rows | Vehicle not in the guide | "Not covered for that vehicle": state the covered years, offer handoff. **Never try a nearby year.** |
| 1 row, `ok` | Exact answer | Show `cell_raw` verbatim and cite `source_row` |
| 1 row, `flagged` | Suspicious value | Show it with a visible warning and a handoff offer |
| 1 row, `quarantined` | Known-bad value; `cell_raw` is NULL | "This entry is flagged for review." Handoff. Write a `kb_gap` with reason `quarantined`. |
| Several rows | Key vs push-to-start, or both circuits | Gate 1 asks which one, **naming the actual values from these rows** |
| `cell_kind = 'doc_ref'` | The cell points to an install guide | Show and link the referenced document |

### 6.3 The other functions

| Function | Use |
|---|---|
| `match_call_cards(org, symptom_vec, n)` | Match the question's symptom against reviewed call cards. Present `confidence = 'unverified'` as "a similar case was handled this way, not confirmed as resolved", never as instructions. |
| `images_for_chunks(chunk_ids[])` | Figures to show beside the answer. Show only these; never feed an image description to the model. |
| `publish_document_version(doc, v)` | The only way chunks go live. One transaction. |
| `retire_document(doc, 'superseded' \| 'archived', replaced_by)` | Takes a document out of search while keeping it for citations. |
| `run_wiring_validation(org, sheet_version)` | V1, V2, V4, V5 at ingestion. Returns counts per rule and per state. |
| `publish_wiring_version(org, sheet_version)` | Atomic swap to a new sheet version. |
| `eval_recall_at_k(org, vec, k)` | Share of true nearest neighbours the index found. Target ≥ 0.95. Run it in the eval suite. |

---

## 7. Ingestion lifecycles

**Document (sync or upload)**
1. Upsert `kb_document` (`sync_state = 'fetched'`). Uploads set `origin = 'upload'` and `uploaded_by`, and must answer "does this replace an existing document?". If yes, call `retire_document(old, 'superseded', new)`.
2. Chunk into version `live_version + 1` as **parents and children** (`src/services/chunking/`). A parent is one heading section (`is_parent = true`, full text, no embedding, never live). A child is a small retrieval unit under it (`parent_chunk_id` set, embedded). Numbered procedures are never split between steps, and a warning box is copied into the procedure it belongs to. Sizes are the `chunk.*` rows in `setting`. For every child whose `text_hash` already exists on the document (same embedding model), **reuse the stored vector** instead of calling the embedding API.
3. Embed only new children. Insert images with the same `version`.
4. `select publish_document_version(doc_id, new_version)`. It refuses if any child lacks a vector. Parents are ignored by it. Publish is all-or-nothing: if any group of children failed to embed, do **not** publish; the previous live version stays live and a retry reuses the vectors already computed.

Uploads accept PDF and Word (`.docx`). A Word file has no pages, so its chunks
have `page_from` / `page_to` null and are cited by section (`section_path`) and
document title instead. Progress is tracked against a single `kb_document_page`
row. Old `.doc` files are rejected at upload.

**Diagrams, photos, charts and tables (migration 0740).** A PDF page that has a
real embedded image, a figure caption, enough vector drawing to be a diagram, or a
table is screenshotted and sent to a vision model; so is each embedded picture in a
Word file. The model's description becomes `figure` children in `kb_chunk`
(`metadata.kind = 'figure'`, `machineGenerated = true`), chunked and embedded like
any other text, and one `kb_image` row per picture records it (`s3_key` is null: no
object storage yet, so the picture itself is not stored or shown). The
description is **machine-generated and unverified**: every stored figure chunk and
every parent carries the `[FIGURE — machine-generated description, unverified]`
marker, `is_citable` stays false, and the answer prompt forbids stating a wire,
pin, value or connection as fact when it appears only in such a description. The
extracted text of a table is kept next to its description, never merged with it.
`kb_image.content_hash` caches each result, so a retry or re-ingest only asks the
model about pictures it has not described. A picture that fails is not fatal: its
page is marked failed ("Needs retry"), the text stays searchable, and the retry
redoes only that page. Tunables (`vision.*` rows): `vision.enabled` (off-switch),
`vision.max_visuals_per_document` (cost cap), `vision.page_render_scale`,
`vision.min_image_px`, `vision.min_vector_ops`.

At query time `match_chunks` returns children. The application then reads each child's parent (`parent_chunk_id`) and sends the parent's text to the answer model, de-duplicated so two children of one section send it once.

**Wiring sheet**
1. Insert every row as sheet version `N + 1` (`is_live = false`). Rows that can't be parsed go to `wiring_quarantine`.
2. The app parser writes its own rule keys (V3 colour vocabulary, V6 parse confidence, V7 link reachable) into `validation_notes`.
3. `select * from run_wiring_validation(org, N + 1)`. It adds V1, V2, V4 and V5, then derives `validation_state` from all keys.
4. Quarantined and flagged rows appear on the dashboard for the sheet owner.
5. `select publish_wiring_version(org, N + 1)`.

**Call card**
1. Pipeline inserts the card with `review_status = 'draft'`, `is_live = false`, both vectors filled.
2. Reviewer's decision → insert `review_action` (`approve` / `edit` / `reject`).
3. `update call_card set is_live = true`. The trigger allows it only after an approval, and sets `review_status = 'indexed'`.

---

## 8. Pitfalls this schema is built around

Each of these was either hit during testing or is a documented platform
behaviour. None of them raises an error by itself: they fail silently.

### 8.1 `hnsw.iterative_scan` defaults to off
With it off, HNSW collects `ef_search` candidates and **then** applies the
`WHERE` clause. Stacked filters can return 2 rows when 20 were asked for. Gate 2
then reports "not covered" while the answer is in the index. It needs pgvector
0.8.0. It can't go in an RDS parameter group, and a session `SET` is lost on
Supabase's transaction pooler. **So each vector function declares it on
itself.** `verify.sql` section 2 fails if a function is missing it.

### 8.2 Keyword search must use OR, not AND
`websearch_to_tsquery` joins words with AND, so "N4 won't power on after
install" matched nothing because "won't" isn't in the manual. Tested: keyword
rank went from none to 1 after switching `&` to `|`. `ts_rank_cd` still
ranks chunks sharing more words higher.

### 8.3 `\b` is backspace in Postgres
Postgres regexes are POSIX: the word boundary is `\y`. A Gate 6 pattern with
`\b` works in Node and Python and matches **nothing** inside SQL, so a
validation sweep reports zero violations because it is broken. Both versions
are seeded: `gate.literal_patterns` (app) and `gate.literal_patterns_pg` (SQL).

### 8.4 Regex inside JSON inside a SQL literal
Write `\\b` in the SQL literal to store the one backslash the regex needs.
`\\\\b` stores a literal backslash and silently matches nothing.

### 8.5 Supabase publishes `public` to the browser
The anon key ships to every browser, and Supabase's default privileges grant
`anon` and `authenticated` access to new tables. **Rerun
`supabase_security.sql` after any migration that adds a table** (it is
idempotent), or add RLS and policies in the migration. `verify.sql` section 7
lists anything left exposed. Tested: both roles are blocked from every table
and every function.

### 8.6 Postgres lets PUBLIC execute every new function
0500 revokes it and grants back only to `drig_app` (plus the eval functions
to `drig_readonly`). Default privileges do the same for later functions.

### 8.7 Extensions live in schema `extensions`
Qualify extension types in DDL: `extensions.vector(1536)`,
`extensions.vector_cosine_ops`, `extensions.gin_trgm_ops`. Functions pin
`search_path = public, extensions`, so their bodies can use `<=>` directly.

### 8.8 At DRIG's size the planner often skips HNSW, and that's fine
With a few thousand live chunks, the planner often sorts every live row
exactly instead of using the index. That gives perfect recall. HNSW takes over
as the corpus grows. The partial index was confirmed usable when forced.
Measure recall rather than assuming it.

### 8.9 Window functions and `LIMIT`
`row_number()` streams, so it doesn't stop the index scan (checked with
EXPLAIN). A window function that needs the whole set, such as
`count(*) over ()` or `percent_rank()`, forces every live row to be read.
Keep `ORDER BY … LIMIT` in an inner query, as the functions do.

### 8.10 Changing the embedding model means re-embedding everything
The dimension (1536) is fixed in the column types. `gate.embedding_model`
records which model produced the stored vectors. A new model means new
columns or a full re-embed, plus a golden-set rerun.

### 8.11 Indexes on populated tables
The initial migrations build indexes on empty tables inside a transaction.
Any later index change on a populated table must use `create index
concurrently` in a migration that is **not** wrapped in a transaction. Before
rebuilding an HNSW index, run `set maintenance_work_mem = '256MB'` in that
session.

### 8.12 Supabase plan
Free projects pause after a week without enough database activity. Use a paid
plan for the pilot. Upgrade the project's Postgres version if the pgvector
check in 0100 fails.

---

## 9. What was tested

Run against a live PostgreSQL 16 with pgvector 0.6.0, with Supabase's `anon`,
`authenticated` and `service_role` roles simulated. 0.6.0 lacks
`iterative_scan`, so the version check and the two 0.8-only settings were
stripped from the **local test copy only**. That limitation is also why
`verify.sql` sections 1–2 failed locally, as intended.

| Test | Result |
|---|---|
| Version check on pgvector 0.6.0 | Fails with the upgrade hint |
| Function `SET hnsw.iterative_scan` on 0.6.0 | Rejected, so an old pgvector fails loudly even without the version check |
| All migrations, then all again | 0 errors both runs; 1 org, 20 settings, 4 roles, 20 grants |
| Publish v1 → v2 | 1,504 live; v1's 1,504 soft-deleted; `live_version = 2` |
| Publish a version with no chunks | Refused |
| Hybrid search, matching vector + text | Target chunk ranked 1 in both searches (after the OR fix) |
| Exact part code with a random vector | Found by keyword search alone |
| Wrong vendor boost | Still returns results |
| Partial HNSW index | Used when forced eligible (`Index Scan using kb_chunk_hnsw`) |
| **Wiring validation on DRIG's real Acura rows** | V1 quarantined exactly 3 (RL ignition pins 8, 9, 10 on a 7-pin connector). V2 flagged exactly 34 (RL, RLX, NSX). The genuine 2014→15 RLX connector change was not flagged. |
| `lookup_wiring` quarantined / missing year | Values NULLed / 0 rows |
| `anon`, `authenticated` | Blocked from tables and functions |
| Call card live without approval, then after reject | Blocked both times |
| `eval_recall_at_k` as `drig_readonly` | 1.000 |
| Supersede | 0 live, 1,504 kept for citations; search returns nothing from it |
| AWS path on a fresh database | 0 errors; 26 tables, 12 functions, 64 indexes; RLS off |

**Still to confirm on real Supabase:** that pgvector is ≥ 0.8.0, that
`verify.sql` sections 1–2 pass, and that `drig_app.<ref>` can log in through
the pooler.

---

## 10. Moving from Supabase to AWS RDS

1. Provision RDS (`01-create-rds.sh`). Apply `db/migrations/*` then
   `db/platform/aws/*` as `drigadmin`. Run `verify.sql`.
2. Freeze writes: stop the sync jobs and put the API in read-only mode.
3. Dump data only from Supabase over the direct connection:
   `pg_dump --data-only --schema=public --no-owner --no-privileges`.
4. On RDS, disable the approval trigger while restoring. `pg_dump` doesn't know
   `call_card` depends on `review_action` (the link is polymorphic, not a
   foreign key), so cards could load first and trip the trigger:
   `alter table call_card disable trigger call_card_approval;` → restore →
   `enable trigger`. Then run `verify.sql` section 5.
5. Copy objects with an S3-compatible sync (`rclone`, or `aws s3 sync` with
   `--endpoint-url` for the source). Keys are unchanged, so no database rows
   need rewriting.
6. Auth: create the users in Cognito, then for each person set
   `auth_provider = 'cognito'` and `external_ref = <new sub>`. **Keep
   `person_id`**, so every conversation, review and upload stays attached.
7. Switch the environment variables (§3). Run `verify.sql`, the golden set and
   `eval_recall_at_k`. Compare against the Supabase baseline. Cut over.
8. Keep the Supabase project read-only for two weeks before deleting it.

---

## 11. Changing the schema later

- Add a new timestamped file in `db/migrations/`. **Never edit a migration
  that has been applied anywhere.**
- New table → carry `org_id`; add RLS and policies (or rerun
  `supabase_security.sql`); grants come from default privileges.
- New vector query → a new SQL function with the same `set` clauses as
  `match_chunks`, then add it to `verify.sql` section 2.
- New tunable → a `setting` row in a migration, never a constant in code.
- Update this document in the same pull request, and run `verify.sql` plus the
  eval suite.

---

# Appendix: complete SQL

Copied verbatim from the tested files. Run in filename order: the portable
files, then the platform file for the target.

## Portable: run on both platforms

### `db/migrations/20260921000100_extensions.sql`

```sql
-- ============================================================================
-- 0100  Extensions                                   PORTABLE: Supabase + RDS
-- ============================================================================
-- Extensions live in schema `extensions`, never `public`. That is Supabase's
-- convention; we adopt it on RDS too so every other migration is identical.
-- Everything that uses an extension type or opclass qualifies it:
--   extensions.vector(1536)   extensions.vector_cosine_ops   extensions.gin_trgm_ops
-- gen_random_uuid() is built into Postgres 13+, so pgcrypto is not needed.
-- ============================================================================

create schema if not exists extensions;

create extension if not exists vector  with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- If an extension was enabled earlier from a dashboard it may sit in `public`.
-- Both are relocatable, so move them rather than fail later on a type lookup.
do $$
begin
  if (select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
       where e.extname = 'vector') <> 'extensions' then
    alter extension vector set schema extensions;
  end if;
  if (select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
       where e.extname = 'pg_trgm') <> 'extensions' then
    alter extension pg_trgm set schema extensions;
  end if;
end $$;

-- Hard stop below pgvector 0.8.0. hnsw.iterative_scan arrived in 0.8.0 and the
-- retrieval functions depend on it to avoid silently returning too few rows.
do $$
declare v text;
begin
  select extversion into v from pg_extension where extname = 'vector';
  if string_to_array(v, '.')::int[] < array[0,8,0] then
    raise exception using
      message = format('pgvector %s is too old: 0.8.0 or newer is required (hnsw.iterative_scan).', v),
      hint    = 'Supabase: Project Settings > Infrastructure > upgrade the Postgres version. '
             || 'RDS: engine 17.1+, 16.5+, 15.9+, 14.14+ or 13.17+.';
  end if;
end $$;
```

### `db/migrations/20260921000200_core_schema.sql`

```sql
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
```

### `db/migrations/20260921000300_indexes.sql`

```sql
-- ============================================================================
-- 0300  Indexes                                      PORTABLE: Supabase + RDS
-- ============================================================================
-- The vector and full-text indexes are PARTIAL. Dead, superseded and
-- unpublished rows are not in the graph at all, so they cannot use up the
-- candidate slots of an approximate search. Queries must repeat the predicate
-- (deleted_at is null and is_live) for the planner to pick these indexes;
-- the SQL functions in 0400 always do.
--
-- Not CONCURRENTLY: these run on empty tables inside a migration transaction.
-- Any later index change on a populated table should use CONCURRENTLY in a
-- migration that is NOT wrapped in a transaction.
-- ============================================================================

-- kb_chunk ------------------------------------------------------------------
create index if not exists kb_chunk_hnsw on kb_chunk
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 200)
  where deleted_at is null and is_live;

create index if not exists kb_chunk_fts on kb_chunk
  using gin (text_search)
  where deleted_at is null and is_live;

create index if not exists kb_chunk_scope on kb_chunk (org_id, source_type, vendor)
  where deleted_at is null and is_live;
create index if not exists kb_chunk_models on kb_chunk using gin (models)
  where deleted_at is null and is_live;
create index if not exists kb_chunk_doc_version on kb_chunk (doc_id, version);
create index if not exists kb_chunk_doc_hash    on kb_chunk (doc_id, text_hash);
create index if not exists kb_chunk_parent      on kb_chunk (parent_chunk_id);

-- kb_image ------------------------------------------------------------------
create index if not exists kb_image_hnsw on kb_image
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 200)
  where deleted_at is null and is_live;
create index if not exists kb_image_chunk on kb_image (chunk_id)
  where deleted_at is null and is_live;
create index if not exists kb_image_doc_version on kb_image (doc_id, version);

-- call_card -----------------------------------------------------------------
create index if not exists call_card_symptom_hnsw on call_card
  using hnsw (symptom_vec extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 200)
  where deleted_at is null and is_live;
create index if not exists call_card_resolution_hnsw on call_card
  using hnsw (resolution_vec extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 200)
  where deleted_at is null and is_live;
create index if not exists call_card_review on call_card (org_id, review_status);

-- wiring_entry: btree lookups. This is a table lookup, not a search. -------
create index if not exists wiring_lookup on wiring_entry
  (org_id, lower(make), lower(model), year, circuit)
  where deleted_at is null and is_live;
create index if not exists wiring_version on wiring_entry (org_id, sheet_version);
create index if not exists wiring_state   on wiring_entry (org_id, validation_state)
  where validation_state <> 'ok';
create index if not exists wiring_model_trgm on wiring_entry
  using gin (model_raw extensions.gin_trgm_ops);   -- alias / typo matching in the vehicle resolver

-- kb_document ---------------------------------------------------------------
create index if not exists kb_document_current on kb_document (org_id, source_id)
  where status = 'current';
create index if not exists kb_document_sync on kb_document (sync_state, synced_at);

-- gaps ----------------------------------------------------------------------
create index if not exists kb_gap_open on kb_gap (org_id, status, created_at desc);
create index if not exists kb_gap_hnsw on kb_gap
  using hnsw (query_vec extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 200)
  where status = 'open';

-- conversation --------------------------------------------------------------
create index if not exists chat_message_session on chat_message (session_id, created_at);
create index if not exists chat_session_person  on chat_session (org_id, person_id, started_at desc);
create index if not exists turn_retrieval_msg   on turn_retrieval (message_id);
create index if not exists citation_msg         on citation (message_id);
create index if not exists handoff_open         on handoff (org_id, opened_at) where closed_at is null;
create index if not exists review_action_entity on review_action (entity_type, entity_id, created_at desc);
create index if not exists event_log_lookup     on event_log (org_id, event_type, ts desc);
```

### `db/migrations/20260921000400_functions.sql`

```sql
-- ============================================================================
-- 0400  Functions                                    PORTABLE: Supabase + RDS
-- ============================================================================
-- RULE: every vector query goes through a function in this file. Application
-- code never writes `<=>` itself.
--
-- Why: each vector function carries its pgvector settings in its own
-- definition (`set hnsw.iterative_scan = ...`). A session-level SET is lost
-- between transactions on Supabase's transaction pooler (port 6543), and an
-- ALTER DATABASE default depends on platform privileges. A function-level SET
-- applies on every call, on every platform, through every pooler mode.
--
-- Every function also pins `search_path = public, extensions`, so the vector
-- type and operators resolve without the caller's search_path, and Supabase's
-- "mutable search_path" lint stays quiet.
--
-- All functions are SECURITY INVOKER (the default). They run with the
-- caller's privileges, so RLS and grants still apply.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- match_chunks: hybrid retrieval over document chunks
--
-- Dense (HNSW) and lexical (full-text) arms run independently, are fused with
-- Reciprocal Rank Fusion, then soft-boosted. Vendor, model and language are
-- BOOSTS, not filters: a wrong guess from frame extraction costs ranking,
-- never the answer. Only tenancy, liveness and source type are hard filters.
--
-- Returns dense_similarity (cosine, 0..1) for every row. Gate 2 thresholds on
-- that, NOT on `score`: RRF scores are rank-based and not comparable across
-- queries.
--
-- Each arm orders and limits in an inner query and numbers rows outside it,
-- so the inner ORDER BY ... LIMIT alone drives the index scan. (row_number()
-- streams, so it would also be fine beside the LIMIT, verified by EXPLAIN.
-- But a window function that needs the whole set, such as count(*) over () or
-- percent_rank(), would force every live row to be read. Keep this shape.)
-- ---------------------------------------------------------------------------
create or replace function match_chunks(
  p_org_id          uuid,
  p_query_embedding extensions.vector(1536),
  p_query_text      text,
  p_match_count     int              default 8,
  p_candidate_k     int              default 20,
  p_rrf_k           int              default 60,
  p_boost_vendor    text             default null,
  p_boost_model     text             default null,
  p_boost_language  text             default null,
  p_w_vendor        double precision default 0.003,
  p_w_model         double precision default 0.002,
  p_w_language      double precision default 0.001,
  p_source_types    text[]           default null   -- null = everything except 'web'
)
returns table (
  chunk_id         uuid,
  doc_id           uuid,
  parent_chunk_id  uuid,
  dense_rank       int,
  lexical_rank     int,
  dense_similarity double precision,
  score            double precision
)
language sql
stable
set search_path = public, extensions
set hnsw.iterative_scan = 'relaxed_order'
set hnsw.ef_search = 100
set hnsw.max_scan_tuples = 40000
as $$
  with
  -- OR, not AND. websearch_to_tsquery joins terms with &, so a natural question
  -- ("N4 won't power on after install") only matches a chunk containing EVERY
  -- word, and the lexical arm returns nothing. Swapping & for | lets any shared
  -- term match; ts_rank_cd then ranks chunks sharing more terms higher.
  q as (
    select replace(websearch_to_tsquery('english', coalesce(p_query_text, ''))::text,
                   ' & ', ' | ')::tsquery as tsq
  ),
  dense as (
    select d.chunk_id, row_number() over (order by d.dist) as rnk
    from (
      select c.chunk_id, c.embedding <=> p_query_embedding as dist
      from kb_chunk c
      where c.org_id = p_org_id
        and c.deleted_at is null
        and c.is_live
        and ((p_source_types is null and c.source_type <> 'web')
             or c.source_type = any(p_source_types))
      order by c.embedding <=> p_query_embedding
      limit p_candidate_k
    ) d
  ),
  lexical as (
    select l.chunk_id, row_number() over (order by l.rnk_score desc) as rnk
    from (
      select c.chunk_id, ts_rank_cd(c.text_search, q.tsq) as rnk_score
      from kb_chunk c, q
      where c.org_id = p_org_id
        and c.deleted_at is null
        and c.is_live
        and c.text_search @@ q.tsq
        and ((p_source_types is null and c.source_type <> 'web')
             or c.source_type = any(p_source_types))
      order by rnk_score desc
      limit p_candidate_k
    ) l
  ),
  fused as (
    select coalesce(d.chunk_id, l.chunk_id) as cid,
           d.rnk as d_rnk,
           l.rnk as l_rnk,
           coalesce(1.0 / (p_rrf_k + d.rnk), 0) + coalesce(1.0 / (p_rrf_k + l.rnk), 0) as rrf
    from dense d
    full outer join lexical l on l.chunk_id = d.chunk_id
  )
  select c.chunk_id,
         c.doc_id,
         c.parent_chunk_id,
         f.d_rnk::int,
         f.l_rnk::int,
         (1 - (c.embedding <=> p_query_embedding))::double precision,
         ( f.rrf
         + case when p_boost_vendor   is not null and c.vendor   = p_boost_vendor    then p_w_vendor   else 0 end
         + case when p_boost_model    is not null and p_boost_model = any(c.models) then p_w_model    else 0 end
         + case when p_boost_language is not null and c.language = p_boost_language then p_w_language else 0 end
         )::double precision
  from fused f
  join kb_chunk c on c.chunk_id = f.cid
  order by 7 desc
  limit p_match_count;
$$;


-- ---------------------------------------------------------------------------
-- match_call_cards: symptom-to-symptom match over reviewed call cards
-- ---------------------------------------------------------------------------
create or replace function match_call_cards(
  p_org_id            uuid,
  p_symptom_embedding extensions.vector(1536),
  p_match_count       int default 5
)
returns table (
  card_id      uuid,
  symptom      text,
  root_cause   text,
  resolution   jsonb,
  confidence   text,
  context_json jsonb,
  similarity   double precision
)
language sql
stable
set search_path = public, extensions
set hnsw.iterative_scan = 'relaxed_order'
set hnsw.ef_search = 100
set hnsw.max_scan_tuples = 40000
as $$
  select m.card_id, m.symptom, m.root_cause, m.resolution, m.confidence, m.context_json,
         (1 - m.dist)::double precision
  from (
    select cc.card_id, cc.symptom, cc.root_cause, cc.resolution, cc.confidence, cc.context_json,
           cc.symptom_vec <=> p_symptom_embedding as dist
    from call_card cc
    where cc.org_id = p_org_id
      and cc.deleted_at is null
      and cc.is_live
    order by cc.symptom_vec <=> p_symptom_embedding
    limit p_match_count
  ) m
  order by m.dist;
$$;


-- ---------------------------------------------------------------------------
-- lookup_wiring: exact match, or no rows. INV-2.
--
-- Zero rows is a valid, required outcome ("not covered for that vehicle").
-- Never fall back to the nearest model year.
--
-- Quarantined rows ARE returned, with cell_raw, wire_colour and pin NULLED.
-- The app can then say "this entry is flagged for review" instead of "not
-- covered", and it cannot serve the bad value even by mistake.
-- Several rows (e.g. key and pts variants) -> Gate 1 asks which one, naming the
-- real distinguishing values from these rows.
-- ---------------------------------------------------------------------------
create or replace function lookup_wiring(
  p_org_id     uuid,
  p_make       text,
  p_model      text,
  p_year       int,
  p_circuit    text default null,   -- '12v' | 'ignition' | null for both
  p_start_type text default null    -- 'pts' | 'key' | null for any
)
returns table (
  entry_id         uuid,
  year             int,
  make             text,
  model_raw        text,
  start_type       text,
  circuit          text,
  cell_kind        text,
  cell_raw         text,
  wire_colour      text,
  pin              int,
  connector_pins   int,
  doc_ref_label    text,
  doc_ref_url      text,
  doc_id           uuid,
  requires_login   boolean,
  validation_state text,
  validation_notes jsonb,
  source_row       int,
  sheet_version    int
)
language sql
stable
set search_path = public, extensions
as $$
  select w.entry_id, w.year, w.make, w.model_raw, w.start_type, w.circuit, w.cell_kind,
         case when w.validation_state = 'quarantined' then null else w.cell_raw    end,
         case when w.validation_state = 'quarantined' then null else w.wire_colour end,
         case when w.validation_state = 'quarantined' then null else w.pin         end,
         w.connector_pins, w.doc_ref_label, w.doc_ref_url, w.doc_id, w.requires_login,
         w.validation_state, w.validation_notes, w.source_row, w.sheet_version
  from wiring_entry w
  where w.org_id = p_org_id
    and w.deleted_at is null
    and w.is_live
    and lower(w.make)  = lower(p_make)
    and lower(w.model) = lower(p_model)
    and w.year = p_year
    and (p_circuit    is null or w.circuit    = p_circuit)
    and (p_start_type is null or w.start_type = p_start_type)
  order by w.start_type nulls first, w.circuit;
$$;


-- ---------------------------------------------------------------------------
-- images_for_chunks: figures to display beside retrieved chunks
--
-- Deliberately does NOT return `description`. That text is model-generated,
-- and leaving it out means application code cannot hand it to the generator
-- by accident. It exists only to make images findable.
-- ---------------------------------------------------------------------------
create or replace function images_for_chunks(p_chunk_ids uuid[])
returns table (
  image_id   uuid,
  chunk_id   uuid,
  doc_id     uuid,
  page       int,
  s3_key     text,
  thumb_key  text,
  caption    text,
  image_type text,
  is_citable boolean
)
language sql
stable
set search_path = public, extensions
as $$
  select i.image_id, i.chunk_id, i.doc_id, i.page, i.s3_key, i.thumb_key,
         i.caption, i.image_type, i.is_citable
  from kb_image i
  where i.chunk_id = any(p_chunk_ids)
    and i.deleted_at is null
    and i.is_live
    and i.image_type <> 'decorative'
  order by i.page nulls last;
$$;


-- ---------------------------------------------------------------------------
-- publish_document_version: the atomic swap
--
-- The only code path that sets kb_chunk.is_live = true. A function call is a
-- single transaction, so retrieval never sees a half-applied version.
-- Old versions are soft-deleted, not removed (INV-7).
-- ---------------------------------------------------------------------------
create or replace function publish_document_version(p_doc_id uuid, p_version int)
returns void
language plpgsql
set search_path = public, extensions
as $$
declare
  v_status  text;
  v_missing int;
begin
  select status into v_status from kb_document where doc_id = p_doc_id for update;
  if v_status is null then
    raise exception 'publish: document % does not exist', p_doc_id;
  end if;
  if v_status <> 'current' then
    raise exception 'publish: document % has status %, only current documents can go live', p_doc_id, v_status;
  end if;
  if not exists (select 1 from kb_chunk
                  where doc_id = p_doc_id and version = p_version and deleted_at is null) then
    raise exception 'publish: document % version % has no chunks', p_doc_id, p_version;
  end if;

  select count(*) into v_missing from kb_chunk
   where doc_id = p_doc_id and version = p_version and deleted_at is null and embedding is null;
  if v_missing > 0 then
    raise exception 'publish: document % version % has % chunk(s) without an embedding', p_doc_id, p_version, v_missing;
  end if;

  update kb_chunk set is_live = false, deleted_at = coalesce(deleted_at, now())
   where doc_id = p_doc_id and version < p_version and deleted_at is null;
  update kb_chunk set is_live = true
   where doc_id = p_doc_id and version = p_version and deleted_at is null;

  update kb_image set is_live = false, deleted_at = coalesce(deleted_at, now())
   where doc_id = p_doc_id and version < p_version and deleted_at is null;
  update kb_image set is_live = true
   where doc_id = p_doc_id and version = p_version and deleted_at is null;

  update kb_document
     set live_version = p_version, sync_state = 'live', synced_at = now(), last_error = null
   where doc_id = p_doc_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- retire_document: supersede or archive
--
-- Chunks leave the index (is_live = false) but are NOT soft-deleted, so
-- citations in old conversations still resolve to the text that was shown.
-- ---------------------------------------------------------------------------
create or replace function retire_document(
  p_doc_id        uuid,
  p_status        text,              -- 'superseded' | 'archived'
  p_superseded_by uuid default null
)
returns void
language plpgsql
set search_path = public, extensions
as $$
begin
  if p_status not in ('superseded','archived') then
    raise exception 'retire: status must be superseded or archived, got %', p_status;
  end if;
  update kb_document set status = p_status where doc_id = p_doc_id;
  if p_superseded_by is not null then
    update kb_document set supersedes_doc_id = p_doc_id where doc_id = p_superseded_by;
  end if;
  update kb_chunk set is_live = false where doc_id = p_doc_id and is_live;
  update kb_image set is_live = false where doc_id = p_doc_id and is_live;
end;
$$;


-- ---------------------------------------------------------------------------
-- run_wiring_validation: source-data checks for a sheet version
--
-- The seven answer gates check an answer against its source. They cannot catch
-- a source that is wrong. These rules run at ingestion, before publish:
--
--   V1  pin number exceeds the connector's own stated pin count   -> quarantine
--   V2  pin +1 per model year for 3+ consecutive years on the same
--       connector (the spreadsheet drag-fill signature)           -> flag
--   V4  12v and ignition cells identical for the same vehicle      -> flag
--   V5  same vehicle + circuit twice with different values         -> quarantine
--
-- V3 (colour vocabulary), V6 (parse confidence) and V7 (doc link reachable)
-- are checked in the application parser, which writes its own keys into
-- validation_notes. This function only touches V1, V2, V4 and V5, then
-- recomputes validation_state from ALL keys, so app-side results survive.
--
-- Regex note: this is PostgreSQL (POSIX). \s and \d work; the word boundary is
-- \y. \b here means BACKSPACE.
-- ---------------------------------------------------------------------------
create or replace function run_wiring_validation(p_org_id uuid, p_sheet_version int)
returns table (rule text, affected int)
language plpgsql
set search_path = public, extensions
as $$
declare n int;
begin
  -- clear only the rules this function owns
  update wiring_entry
     set validation_notes = validation_notes - 'V1' - 'V2' - 'V4' - 'V5'
   where org_id = p_org_id and sheet_version = p_sheet_version and deleted_at is null;

  -- V1
  update wiring_entry
     set validation_notes = validation_notes || jsonb_build_object('V1',
           format('pin %s on a %s-pin connector', pin, connector_pins))
   where org_id = p_org_id and sheet_version = p_sheet_version and deleted_at is null
     and pin is not null and connector_pins is not null and pin > connector_pins;
  get diagnostics n = row_count;
  rule := 'V1 pin exceeds connector pin count (quarantine)'; affected := n; return next;

  -- V2  gaps-and-islands over (vehicle, circuit, connector description)
  with base as (
    select entry_id, make, model, coalesce(start_type, '') as st, circuit, year, pin,
           regexp_replace(lower(cell_raw), ',?\s*pin\s*\d+\s*$', '') as stem
    from wiring_entry
    where org_id = p_org_id and sheet_version = p_sheet_version and deleted_at is null
      and cell_kind = 'inline' and pin is not null
  ),
  stepped as (
    select b.*,
           case when b.pin  - lag(b.pin)  over w = 1
                 and b.year - lag(b.year) over w = 1 then 0 else 1 end as brk
    from base b
    window w as (partition by make, model, st, circuit, stem order by year)
  ),
  islands as (
    select s.*,
           sum(brk) over (partition by make, model, st, circuit, stem order by year) as grp
    from stepped s
  ),
  runs as (
    select entry_id,
           count(*) over (partition by make, model, st, circuit, stem, grp) as run_len
    from islands
  )
  update wiring_entry w
     set validation_notes = w.validation_notes || jsonb_build_object('V2',
           format('pin rises by 1 each model year across %s consecutive years on the same connector', r.run_len))
    from runs r
   where r.entry_id = w.entry_id and r.run_len >= 3;
  get diagnostics n = row_count;
  rule := 'V2 drag-fill pattern (flag)'; affected := n; return next;

  -- V4
  update wiring_entry w
     set validation_notes = w.validation_notes || jsonb_build_object('V4',
           '12v and ignition cells are identical for this vehicle')
    from wiring_entry o
   where w.org_id = p_org_id and w.sheet_version = p_sheet_version and w.deleted_at is null
     and o.org_id = w.org_id and o.sheet_version = w.sheet_version and o.deleted_at is null
     and o.year = w.year and lower(o.make) = lower(w.make) and lower(o.model) = lower(w.model)
     and coalesce(o.start_type, '') = coalesce(w.start_type, '')
     and o.circuit <> w.circuit
     and w.cell_kind = 'inline' and o.cell_kind = 'inline'
     and lower(o.cell_raw) = lower(w.cell_raw);
  get diagnostics n = row_count;
  rule := 'V4 identical 12v and ignition (flag)'; affected := n; return next;

  -- V5
  update wiring_entry w
     set validation_notes = w.validation_notes || jsonb_build_object('V5',
           'the same vehicle and circuit appear more than once with different values')
    from wiring_entry o
   where w.org_id = p_org_id and w.sheet_version = p_sheet_version and w.deleted_at is null
     and o.org_id = w.org_id and o.sheet_version = w.sheet_version and o.deleted_at is null
     and o.entry_id <> w.entry_id
     and o.year = w.year and lower(o.make) = lower(w.make) and lower(o.model) = lower(w.model)
     and coalesce(o.start_type, '') = coalesce(w.start_type, '')
     and o.circuit = w.circuit
     and lower(o.cell_raw) <> lower(w.cell_raw);
  get diagnostics n = row_count;
  rule := 'V5 conflicting duplicates (quarantine)'; affected := n; return next;

  -- derive state from every rule key, including app-side ones
  update wiring_entry
     set validation_state = case
           when validation_notes ?| array['V1','V5'] then 'quarantined'
           when validation_notes <> '{}'::jsonb      then 'flagged'
           else 'ok' end
   where org_id = p_org_id and sheet_version = p_sheet_version and deleted_at is null;

  return query
    select 'state: ' || validation_state, count(*)::int
    from wiring_entry
    where org_id = p_org_id and sheet_version = p_sheet_version and deleted_at is null
    group by validation_state
    order by 1;
end;
$$;


-- ---------------------------------------------------------------------------
-- publish_wiring_version: atomic swap for a whole sheet version
-- Run run_wiring_validation first. Old versions are soft-deleted.
-- ---------------------------------------------------------------------------
create or replace function publish_wiring_version(p_org_id uuid, p_sheet_version int)
returns void
language plpgsql
set search_path = public, extensions
as $$
begin
  if not exists (select 1 from wiring_entry
                  where org_id = p_org_id and sheet_version = p_sheet_version and deleted_at is null) then
    raise exception 'publish_wiring: no rows for sheet_version %', p_sheet_version;
  end if;
  update wiring_entry set is_live = false, deleted_at = coalesce(deleted_at, now())
   where org_id = p_org_id and sheet_version < p_sheet_version and deleted_at is null;
  update wiring_entry set is_live = true
   where org_id = p_org_id and sheet_version = p_sheet_version and deleted_at is null;
end;
$$;


-- ---------------------------------------------------------------------------
-- INV-6, enforced by the database: a call card cannot go live unless its most
-- recent review action is an approval. A trigger rather than a check in app
-- code, so a stray UPDATE cannot bypass it.
-- ---------------------------------------------------------------------------
create or replace function enforce_call_card_approval()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare latest text;
begin
  if new.is_live and not coalesce(old.is_live, false) then
    select ra.action into latest
      from review_action ra
     where ra.entity_type = 'call_card' and ra.entity_id = new.card_id
     order by ra.created_at desc
     limit 1;
    if coalesce(latest, '') not in ('approve','edit') then
      raise exception 'INV-6: call card % cannot go live without an approval review_action', new.card_id;
    end if;
    if new.symptom_vec is null or new.resolution_vec is null then
      raise exception 'call card % cannot go live without both embeddings', new.card_id;
    end if;
    new.review_status := 'indexed';
  end if;
  return new;
end;
$$;

drop trigger if exists call_card_approval on call_card;
create trigger call_card_approval
  before insert or update of is_live on call_card
  for each row execute function enforce_call_card_approval();


-- ---------------------------------------------------------------------------
-- Recall evaluation. Measures whether the ANN index hides answers.
--   exact = true nearest neighbours, index scans disabled
--   ann   = the production index path, same settings as match_chunks
-- recall@k = overlap / k. Target >= 0.95. Wire into the eval suite / CI.
-- ---------------------------------------------------------------------------
create or replace function eval_exact_top_k(
  p_org_id uuid, p_query_embedding extensions.vector(1536), p_k int default 8)
returns table (chunk_id uuid)
language sql
stable
set search_path = public, extensions
set enable_indexscan = off
set enable_bitmapscan = off
as $$
  select c.chunk_id from kb_chunk c
  where c.org_id = p_org_id and c.deleted_at is null and c.is_live
  order by c.embedding <=> p_query_embedding
  limit p_k;
$$;

create or replace function eval_ann_top_k(
  p_org_id uuid, p_query_embedding extensions.vector(1536), p_k int default 8)
returns table (chunk_id uuid)
language sql
stable
set search_path = public, extensions
set hnsw.iterative_scan = 'relaxed_order'
set hnsw.ef_search = 100
set hnsw.max_scan_tuples = 40000
as $$
  select c.chunk_id from kb_chunk c
  where c.org_id = p_org_id and c.deleted_at is null and c.is_live
  order by c.embedding <=> p_query_embedding
  limit p_k;
$$;

create or replace function eval_recall_at_k(
  p_org_id uuid, p_query_embedding extensions.vector(1536), p_k int default 8)
returns numeric
language sql
stable
set search_path = public, extensions
as $$
  select round(count(*)::numeric / nullif(p_k, 0), 3)
  from eval_exact_top_k(p_org_id, p_query_embedding, p_k) e
  join eval_ann_top_k(p_org_id, p_query_embedding, p_k) a using (chunk_id);
$$;
```

### `db/migrations/20260921000500_roles_and_grants.sql`

```sql
-- ============================================================================
-- 0500  Roles and grants                             PORTABLE: Supabase + RDS
-- ============================================================================
-- The application connects as drig_app on BOTH platforms, never as the admin
-- user (postgres on Supabase, drigadmin on RDS). Same role, same grants,
-- same behaviour. The only difference is how the role authenticates.
--
-- Passwords are NEVER set in a migration. Set them once per environment, from
-- the secrets store, outside version control:
--     alter role drig_app password '<value from secrets>';
-- On RDS, prefer IAM auth (see the AWS platform file).
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'drig_app') then
    create role drig_app login;          -- cannot log in until a password or IAM is set
  end if;
  if not exists (select 1 from pg_roles where rolname = 'drig_readonly') then
    create role drig_readonly login;     -- dashboards and ad-hoc analysis
  end if;
end $$;

grant usage on schema public     to drig_app, drig_readonly;
grant usage on schema extensions to drig_app, drig_readonly;

grant select, insert, update, delete on all tables    in schema public to drig_app;
grant usage, select                  on all sequences in schema public to drig_app;
grant select                         on all tables    in schema public to drig_readonly;

-- Postgres lets PUBLIC execute every new function by default. Take that away,
-- then grant back only what each role needs.
revoke execute on all functions in schema public from public;
grant  execute on all functions in schema public to drig_app;
grant  execute on function eval_recall_at_k(uuid, extensions.vector, int) to drig_readonly;
grant  execute on function eval_exact_top_k(uuid, extensions.vector, int) to drig_readonly;
grant  execute on function eval_ann_top_k(uuid, extensions.vector, int)   to drig_readonly;

-- Same rules for objects created by later migrations.
alter default privileges in schema public grant select, insert, update, delete on tables to drig_app;
alter default privileges in schema public grant usage, select on sequences to drig_app;
alter default privileges in schema public grant select on tables to drig_readonly;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to drig_app;
```

### `db/migrations/20260921000600_seed.sql`

```sql
-- ============================================================================
-- 0600  Seed                                         PORTABLE: Supabase + RDS
-- ============================================================================
-- Reference data every environment needs, production included. That is why
-- this is a migration and not supabase/seed.sql, which only runs on local
-- `supabase db reset`. Every insert is idempotent.
-- ============================================================================

insert into organization (name) values ('DRIG USA')
  on conflict (name) do nothing;

insert into workflow (org_id, code, name)
select org_id, 'qc_support', 'QC Support' from organization where name = 'DRIG USA'
  on conflict (org_id, code) do nothing;

insert into app_role (org_id, code, name)
select o.org_id, r.code, r.name
from organization o
cross join (values
  ('technician', 'Field Technician'),
  ('engineer',   'In-office Engineer'),
  ('manager',    'Manager'),
  ('admin',      'Administrator')
) as r(code, name)
where o.name = 'DRIG USA'
  on conflict (org_id, code) do nothing;

insert into permission (code, description) values
  ('chat.ask',              'Ask the assistant questions'),
  ('handoff.receive',       'Receive escalated conversations'),
  ('conversation.view_all', 'See every conversation, not only your own'),
  ('knowledge.upload',      'Upload documents'),
  ('knowledge.review',      'Approve, edit or reject call cards and flagged data'),
  ('knowledge.publish',     'Publish documents and card batches'),
  ('knowledge.retire',      'Supersede or archive documents'),
  ('dashboard.view',        'See dashboards and the gap report'),
  ('settings.edit',         'Change thresholds, prompts and allowlists'),
  ('users.manage',          'Add people and assign roles')
  on conflict (code) do nothing;

-- Permissions are checked in code. Roles are data. Adding a role is a row.
insert into app_role_permission (role_id, permission_id)
select r.role_id, p.permission_id
from app_role r
join organization o on o.org_id = r.org_id and o.name = 'DRIG USA'
join (values
  ('technician', 'chat.ask'),
  ('engineer',   'chat.ask'), ('engineer', 'handoff.receive'), ('engineer', 'knowledge.review'),
  ('manager',    'chat.ask'), ('manager', 'conversation.view_all'), ('manager', 'knowledge.upload'),
  ('manager',    'knowledge.review'), ('manager', 'knowledge.publish'), ('manager', 'knowledge.retire'),
  ('manager',    'dashboard.view'),
  ('admin',      'chat.ask'), ('admin', 'conversation.view_all'), ('admin', 'knowledge.upload'),
  ('admin',      'knowledge.review'), ('admin', 'knowledge.publish'), ('admin', 'knowledge.retire'),
  ('admin',      'dashboard.view'), ('admin', 'settings.edit'), ('admin', 'users.manage')
) as m(role_code, perm_code) on m.role_code = r.code
join permission p on p.code = m.perm_code
  on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Tunables (INV-4). Starting values; tune them on the golden set, not by feel.
--
-- Regex escaping: a SQL literal holding JSON holding a regex. `\\b` in the
-- literal stores the single backslash the regex needs. `\\\\b` would store a
-- literal backslash and the pattern would silently match nothing.
-- Two dialects of the same Gate 6 patterns:
--   gate.literal_patterns     application side (JS / Python / PCRE): \b
--   gate.literal_patterns_pg  inside Postgres (POSIX): \y  -- \b is BACKSPACE there
-- ---------------------------------------------------------------------------
insert into setting (org_id, workflow_id, key, value_json, description)
select o.org_id, w.workflow_id, s.key, s.val::jsonb, s.descr
from organization o
join workflow w on w.org_id = o.org_id and w.code = 'qc_support'
cross join (values
  ('retrieval.admit_min_similarity', '0.35',
   'Gate 2. Best dense_similarity below this means no generation. Tune on the golden set: raise to refuse more, lower to answer more. Watch the false-refusal rate as closely as the hallucination rate.'),
  ('retrieval.admit_on_exact_code', 'true',
   'Gate 2. Admit anyway when the lexical arm matched an exact part or model code from the question.'),
  ('retrieval.match_count',   '8',     'Chunks passed to the generator.'),
  ('retrieval.candidate_k',   '20',    'Candidates per search arm before fusion.'),
  ('retrieval.rrf_k',         '60',    'Reciprocal Rank Fusion constant.'),
  ('retrieval.boost_vendor',  '0.003', 'Soft boost for a vendor match. RRF top score per arm is about 0.016, so keep boosts small.'),
  ('retrieval.boost_model',   '0.002', 'Soft boost for a model match.'),
  ('retrieval.boost_language','0.001', 'Soft boost for the technician''s language.'),
  ('gate.frame_model',    '"gpt-5.6-luna"',  'Small fast model for frame extraction. Use a dated snapshot id when the provider offers one, never a floating alias.'),
  ('gate.coverage_model', '"gpt-5.6-luna"',  'Small fast model for the coverage gate.'),
  ('gate.answer_model',   '"gpt-5.6-terra"', 'Generation model. Changing it is a deliberate change that reruns the golden set.'),
  ('gate.embedding_model','"text-embedding-3-small"',  'Must match the vector(1536) columns. Changing it means re-embedding everything.'),
  ('gate.literal_patterns',
   '["[A-Z0-9]{2,}-[A-Z0-9]{2,}", "\\b\\d+\\s?(V|A|Nm|ft-lb|mm|AWG|ohm)\\b", "\\bpin\\s?\\d+\\b"]',
   'Gate 6, APPLICATION side (PCRE / JS / Python).'),
  ('gate.literal_patterns_pg',
   '["[A-Z0-9]{2,}-[A-Z0-9]{2,}", "\\y(\\d+\\s?(?:V|A|Nm|ft-lb|mm|AWG|ohm))\\y", "\\y(pin\\s?\\d+)\\y"]',
   'Gate 6 patterns for use INSIDE Postgres (POSIX). Word boundary is \y.'),
  ('gate.safety_lexicon',
   '["disconnect", "isolate", "de-energize", "de-energise", "warning", "caution", "before you", "do not"]',
   'Gate 7. A cited source sentence containing any of these must survive into the answer.'),
  ('gate.deadline_ms', '22000', 'Hard internal deadline. On breach, send what is validated plus a handoff offer.'),
  ('slots.required',
   '{"wiring_lookup": ["make", "model", "year", "circuit"], "troubleshoot": ["symptom"], "info": ["product"], "procedure": ["product"]}',
   'Gate 1. Required slots per intent. Missing slots are only asked about when the answer depends on them.'),
  ('web.allowlist', '[]', 'Domains the web fallback may fetch. Empty disables the fallback. Review monthly.'),
  ('limits.queries_per_tech_per_day', '80', 'Per-technician rate limit.'),
  ('voice.confirm_below_confidence', '0.75', 'Below this ASR confidence, confirm what was heard before searching.')
) as s(key, val, descr)
where o.name = 'DRIG USA'
  on conflict (org_id, workflow_id, key) do nothing;
```

## Supabase only

### `db/platform/supabase/20260921000900_supabase_security.sql`

```sql
-- ============================================================================
-- 0900  Supabase security                            SUPABASE ONLY
-- ============================================================================
-- Supabase publishes every table in `public` through its Data API, and its
-- default privileges grant `anon` and `authenticated` access to new tables.
-- The anon key ships in browsers. Without this file, anyone holding it could
-- read the knowledge base and every conversation.
--
-- This product never uses the Data API: the browser talks only to our backend,
-- and the backend uses a plain Postgres driver as drig_app. So:
--   * RLS on for every table, with policies ONLY for drig_app / drig_readonly
--   * anon and authenticated lose every table, sequence and function grant
--
-- Re-run this whole file after any migration that adds a table: it is
-- idempotent. verify.sql lists any table that slipped through without RLS.
-- The admin role (postgres) owns the tables and bypasses RLS, which is what
-- migrations need.
-- ============================================================================

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('revoke all on public.%I from anon, authenticated', t.tablename);

    execute format('drop policy if exists drig_app_all on public.%I', t.tablename);
    execute format('create policy drig_app_all on public.%I for all to drig_app using (true) with check (true)', t.tablename);

    execute format('drop policy if exists drig_readonly_select on public.%I', t.tablename);
    execute format('create policy drig_readonly_select on public.%I for select to drig_readonly using (true)', t.tablename);
  end loop;
end $$;

revoke all     on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from anon, authenticated;

-- Stop Supabase's default grants from applying to future objects we create.
alter default privileges for role postgres in schema public revoke all     on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all     on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
```

## AWS RDS only

### `db/platform/aws/20260921000900_aws_platform.sql`

```sql
-- ============================================================================
-- 0900  AWS RDS platform                             AWS RDS ONLY
-- ============================================================================
-- RDS exposes no Data API, and the database is reachable only from the app
-- security group, so RLS is not needed here. drig_app gets the same effective
-- access it has on Supabase.
-- ============================================================================

-- Let drig_app sign in with a short-lived IAM token instead of a password.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'rds_iam') then
    grant rds_iam to drig_app;
  end if;
end $$;

-- Convenience for people running ad-hoc psql sessions. The product does not
-- depend on it: every function pins its own search_path.
do $$
begin
  execute format('alter database %I set search_path = "$user", public, extensions', current_database());
end $$;
```

## Verification: run after migrations and in CI

### `db/verify/verify.sql`

```sql
-- ============================================================================
-- verify.sql                                         PORTABLE: Supabase + RDS
-- ============================================================================
-- Run as the admin user after migrations, and in CI. Every row prints
-- PASS / FAIL / INFO. Do not ingest data with any FAIL outstanding.
-- Supabase-only checks report INFO on RDS (the anon role does not exist there).
-- ============================================================================

\pset pager off

\echo '== 1. pgvector ================================================'
select 'pgvector version' as check_name,
       extversion as value,
       case when string_to_array(extversion, '.')::int[] >= array[0,8,0]
            then 'PASS' else 'FAIL: need >= 0.8.0' end as status
from pg_extension where extname = 'vector'
union all
select 'extension schema', n.nspname,
       case when n.nspname = 'extensions' then 'PASS' else 'FAIL: should be extensions' end
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'vector';

\echo '== 2. vector functions carry their own pgvector settings ======'
select p.proname as function_name,
       case when 'hnsw.iterative_scan=relaxed_order' = any(p.proconfig)
             and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
            then 'PASS'
            else 'FAIL: missing SET clause; results will be silently thin' end as status
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('match_chunks', 'match_call_cards', 'eval_ann_top_k')
order by 1;

\echo '== 3. vector and full-text indexes are partial ================'
select indexname,
       case when indexdef ilike '%WHERE%' then 'PASS' else 'FAIL: not partial' end as status
from pg_indexes
where schemaname = 'public'
  and (indexdef ilike '%using hnsw%' or indexname like '%fts%')
order by 1;

\echo '== 4. is_live invariant ========================================'
select 'live chunks that should not be live' as check_name,
       count(*)::text as value,
       case when count(*) = 0 then 'PASS' else 'FAIL: fix via publish/retire functions' end as status
from kb_chunk c
join kb_document d on d.doc_id = c.doc_id
where c.is_live
  and (d.status <> 'current' or c.version <> d.live_version
       or c.embedding is null or c.deleted_at is not null);

\echo '== 5. INV-6: every live call card has an approval ============='
select 'live cards without approval' as check_name,
       count(*)::text as value,
       case when count(*) = 0 then 'PASS' else 'FAIL' end as status
from call_card cc
where cc.is_live
  and coalesce((select ra.action from review_action ra
                 where ra.entity_type = 'call_card' and ra.entity_id = cc.card_id
                 order by ra.created_at desc limit 1), '') not in ('approve', 'edit');

\echo '== 6. app role cannot touch what it should not ================='
select r.rolname,
       r.rolsuper as superuser,
       r.rolbypassrls as bypass_rls,
       case when not r.rolsuper and not r.rolbypassrls then 'PASS' else 'FAIL' end as status
from pg_roles r
where r.rolname in ('drig_app', 'drig_readonly');

\echo '== 7. Supabase: nothing exposed to anon / authenticated ========'
select c.relname as table_name,
       case
         when not exists (select 1 from pg_roles where rolname = 'anon') then 'INFO: not Supabase'
         when not c.relrowsecurity then 'FAIL: RLS off; rerun supabase_security.sql'
         when has_table_privilege('anon', c.oid, 'select') then 'FAIL: anon can select'
         else 'PASS'
       end as status
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and (not exists (select 1 from pg_roles where rolname = 'anon')
       or not c.relrowsecurity
       or has_table_privilege('anon', c.oid, 'select'))
union all
select 'all public tables locked down', 'PASS'
where exists (select 1 from pg_roles where rolname = 'anon')
  and not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (not c.relrowsecurity or has_table_privilege('anon', c.oid, 'select')));

\echo '== 8. seed ====================================================='
select 'organizations' as item, count(*)::text as value,
       case when count(*) = 1 then 'PASS' else 'FAIL: expected exactly 1' end as status
from organization
union all
select 'settings', count(*)::text,
       case when count(*) >= 20 then 'PASS' else 'FAIL' end from setting
union all
select 'roles', count(*)::text,
       case when count(*) = 4 then 'PASS' else 'FAIL' end from app_role
union all
select 'role-permission grants', count(*)::text,
       case when count(*) > 0 then 'PASS' else 'FAIL' end from app_role_permission;

\echo '== 9. wiring validation summary ================================'
select validation_state, count(*) as rows
from wiring_entry
where deleted_at is null and is_live
group by validation_state
order by 1;

\echo ''
\echo 'Recall (after ingestion, per golden-set query vector):'
\echo '  select eval_recall_at_k(<org_id>, <query_vector>, 8);   -- target >= 0.95'
```

