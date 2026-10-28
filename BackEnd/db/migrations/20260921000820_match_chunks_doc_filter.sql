-- ============================================================================
-- 0820  match_chunks: optional document filter           PORTABLE: Supabase + RDS
-- ============================================================================
-- Adds p_doc_ids. When a question names a piece of equipment ("AD Plus2.0"),
-- the application resolves it to the live documents about that equipment and
-- passes their ids here, so another product's manual with a similar procedure
-- (a ZenCAM PLUS guide) cannot outrank the one the technician asked about.
--
-- DEVIATION from 0400's "boosts, not filters": this one IS a hard filter, in
-- both arms. It is safe because the ids are never a free guess: they are
-- picked from the live document catalog by name, and the application falls
-- back to an unfiltered search when the filtered one returns nothing
-- (src/services/ragRetrieval.service.js). Null keeps the old behaviour.
--
-- Adding a parameter changes the signature, and `create or replace` would
-- leave the old one beside it as an overload; a call by name that omits
-- p_doc_ids would then be ambiguous. So the old signature is dropped first.
-- 0400 recreates it on every full migration run, and this file drops it again.
-- ============================================================================

drop function if exists match_chunks(
  uuid, extensions.vector, text, int, int, int, text, text, text,
  double precision, double precision, double precision, text[]
);

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
  p_source_types    text[]           default null,  -- null = everything except 'web'
  p_doc_ids         uuid[]           default null   -- null = every document
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
  -- OR, not AND: see 0400.
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
        and (p_doc_ids is null or c.doc_id = any(p_doc_ids))
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
        and (p_doc_ids is null or c.doc_id = any(p_doc_ids))
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

-- Same grants 0500 gives every function (it ran before this one existed).
revoke execute on function match_chunks(
  uuid, extensions.vector, text, int, int, int, text, text, text,
  double precision, double precision, double precision, text[], uuid[]
) from public;
grant execute on function match_chunks(
  uuid, extensions.vector, text, int, int, int, text, text, text,
  double precision, double precision, double precision, text[], uuid[]
) to drig_app;
