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
