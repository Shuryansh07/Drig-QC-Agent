-- ============================================================================
-- 0400  Functions                                    PORTABLE: Supabase + RDS
-- ============================================================================
-- RULE: every vector query goes through a function in this file. Application
-- code never writes `<=>` itself.
--
-- DEVIATION FROM THE ORIGINAL DESIGN (see Plan/DATABASE.md section 8.1 for
-- the original intent): match_chunks, match_call_cards and eval_ann_top_k
-- were designed to declare `set hnsw.iterative_scan = 'relaxed_order'` (etc.)
-- as a function-level SET clause in CREATE FUNCTION. On Supabase, the
-- connecting role (`postgres`) is not a true Postgres superuser, and
-- embedding a SET clause for a custom-extension GUC in CREATE FUNCTION
-- requires a parameter ACL only a real superuser can grant ("permission
-- denied to set parameter hnsw.iterative_scan"). A plain runtime
-- `set_config(name, value, true)` call (equivalent to SET LOCAL: scoped to
-- the current transaction, never process-wide) is NOT subject to that ACL
-- and was confirmed to work. So these three functions are `language plpgsql`
-- (not `sql`) and call set_config() as their first statements instead of
-- using a declarative SET clause. The guarantee is unchanged: the setting
-- applies only for this function call, on every platform, through every
-- pooler mode — just reached by a different mechanism on Supabase. If this
-- ever runs on a true superuser connection (e.g. some RDS setups), the
-- original declarative-SET form would also work, but this form works
-- everywhere, so it's kept as the one portable implementation.
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
language plpgsql
stable
set search_path = public, extensions
as $$
begin
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  perform set_config('hnsw.ef_search', '100', true);
  perform set_config('hnsw.max_scan_tuples', '40000', true);

  return query
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
end;
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
language plpgsql
stable
set search_path = public, extensions
as $$
begin
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  perform set_config('hnsw.ef_search', '100', true);
  perform set_config('hnsw.max_scan_tuples', '40000', true);

  return query
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
end;
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
language plpgsql
stable
set search_path = public, extensions
as $$
begin
  perform set_config('enable_indexscan', 'off', true);
  perform set_config('enable_bitmapscan', 'off', true);
  return query
  select c.chunk_id from kb_chunk c
  where c.org_id = p_org_id and c.deleted_at is null and c.is_live
  order by c.embedding <=> p_query_embedding
  limit p_k;
end;
$$;

create or replace function eval_ann_top_k(
  p_org_id uuid, p_query_embedding extensions.vector(1536), p_k int default 8)
returns table (chunk_id uuid)
language plpgsql
stable
set search_path = public, extensions
as $$
begin
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  perform set_config('hnsw.ef_search', '100', true);
  perform set_config('hnsw.max_scan_tuples', '40000', true);
  return query
  select c.chunk_id from kb_chunk c
  where c.org_id = p_org_id and c.deleted_at is null and c.is_live
  order by c.embedding <=> p_query_embedding
  limit p_k;
end;
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
