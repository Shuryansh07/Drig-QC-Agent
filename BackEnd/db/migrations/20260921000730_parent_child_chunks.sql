-- ============================================================================
-- 0730  Parent / child chunks                        PORTABLE: Supabase + RDS
-- ============================================================================
-- ADDITIVE. DATABASE.md §6.1: "Send the parent chunk to the model. The child
-- chunk was only the match." kb_chunk.parent_chunk_id already exists; this
-- migration makes the parent rows safe to store:
--
--   * is_parent marks a parent. A parent holds the full section text the answer
--     model reads. It is NEVER embedded and NEVER live, so match_chunks (which
--     only sees live rows, via the partial HNSW / full-text indexes) can never
--     return a parent as a match. The check constraint enforces that in the
--     database rather than trusting the ingestion code.
--   * publish_document_version is redefined so parents neither block a publish
--     (it refuses chunks without embeddings) nor get flipped live by it.
--   * The chunker's sizes are `setting` rows (INV-4), not constants in code.
--
-- Existing flat chunks (parent_chunk_id null, is_parent false) are unaffected:
-- they remain standalone, searchable chunks.
-- ============================================================================

alter table kb_chunk add column if not exists is_parent boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'kb_chunk_parent_not_searchable') then
    alter table kb_chunk
      add constraint kb_chunk_parent_not_searchable
      check (not is_parent or (not is_live and embedding is null));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Chunk identity is per VERSION. 0720 keyed (doc_id, page_from, chunk_index)
-- without version, so re-ingesting a document (version 2) would collide with
-- the soft-deleted rows of version 1 that INV-7 keeps for old citations. The
-- chunker is deterministic, so version 2 of an unchanged PDF reuses the same
-- indexes; they only need to be unique within one version.
-- ---------------------------------------------------------------------------
drop index if exists kb_chunk_page_chunk_idx;
create unique index if not exists kb_chunk_version_page_chunk_idx
  on kb_chunk (doc_id, version, page_from, chunk_index)
  where chunk_index is not null;

-- ---------------------------------------------------------------------------
-- publish_document_version: same atomic swap as 0400, parent-aware.
-- Only children (and standalone chunks) need an embedding and go live. Parents
-- of the old version are soft-deleted with it; parents of the new version stay
-- non-live by design and are reached through parent_chunk_id.
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
                  where doc_id = p_doc_id and version = p_version and deleted_at is null and not is_parent) then
    raise exception 'publish: document % version % has no chunks', p_doc_id, p_version;
  end if;

  select count(*) into v_missing from kb_chunk
   where doc_id = p_doc_id and version = p_version and deleted_at is null
     and not is_parent and embedding is null;
  if v_missing > 0 then
    raise exception 'publish: document % version % has % chunk(s) without an embedding', p_doc_id, p_version, v_missing;
  end if;

  update kb_chunk set is_live = false, deleted_at = coalesce(deleted_at, now())
   where doc_id = p_doc_id and version < p_version and deleted_at is null;
  update kb_chunk set is_live = true
   where doc_id = p_doc_id and version = p_version and deleted_at is null and not is_parent;

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
-- Chunker tunables (INV-4). Sizes are estimated tokens (about 4 characters
-- each). Starting values: tune them on the golden question set, not by feel.
-- ---------------------------------------------------------------------------
insert into setting (org_id, workflow_id, key, value_json, description)
select o.org_id, w.workflow_id, s.key, s.val::jsonb, s.descr
from organization o
join workflow w on w.org_id = o.org_id and w.code = 'qc_support'
cross join (values
  ('chunk.child_target_tokens', '250',
   'Chunker. Prose children are filled up to about this size. Small children match one specific symptom or part code.'),
  ('chunk.child_max_tokens', '380',
   'Chunker. A single prose paragraph longer than this is split at sentence boundaries with overlap.'),
  ('chunk.child_overlap_tokens', '30',
   'Chunker. Overlap between the pieces of a split paragraph. Never applied between list steps.'),
  ('chunk.procedure_max_tokens', '800',
   'Chunker. A numbered procedure stays in ONE child up to this size; beyond it, it splits only between steps, repeating its warnings in every part.'),
  ('chunk.parent_min_tokens', '150',
   'Chunker. A section shorter than this rolls into the following section instead of standing alone as a parent.'),
  ('chunk.parent_max_tokens', '1200',
   'Chunker. A section longer than this is split into several parents at block boundaries. This is what the answer model reads, so it bounds prompt size per match.')
) as s(key, val, descr)
where o.name = 'DRIG USA'
  on conflict (org_id, workflow_id, key) do nothing;
