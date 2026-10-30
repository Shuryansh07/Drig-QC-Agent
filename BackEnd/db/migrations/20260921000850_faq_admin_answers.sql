-- ============================================================================
-- 0850  Admin-written FAQ answers                    PORTABLE: Supabase + RDS
-- ============================================================================
-- An admin can answer a question the assistant could not (the Unanswered
-- questions tab). It goes into faq_entry like a resolved question, with its
-- question embedded, but it has no source passages: the admin's text IS the
-- answer. match_faq now says where each entry came from, so a close match on an
-- admin answer is given as the reply, while a technician-resolved one still only
-- brings back its passages and serves as a reference.
-- ============================================================================

alter table faq_entry
  add column if not exists source text not null default 'technician'
    check (source in ('technician', 'admin'));

-- The return type changes, so the function is dropped and created again.
drop function if exists match_faq(uuid, extensions.vector, int, double precision);

create function match_faq(
  p_org_id          uuid,
  p_query_embedding extensions.vector(1536),
  p_match_count     int              default 3,
  p_min_similarity  double precision default 0.0
)
returns table (
  faq_id           uuid,
  question         text,
  answer           text,
  source_chunk_ids uuid[],
  citations        jsonb,
  source           text,
  similarity       double precision
)
language sql
stable
set search_path = public, extensions
as $$
  select f.faq_id, f.question, f.answer, f.source_chunk_ids, f.citations, f.source,
         1 - (f.embedding <=> p_query_embedding) as similarity
    from faq_entry f
   where f.org_id = p_org_id
     and f.active
     and 1 - (f.embedding <=> p_query_embedding) >= p_min_similarity
   order by f.embedding <=> p_query_embedding
   limit p_match_count;
$$;

revoke execute on function match_faq(uuid, extensions.vector, int, double precision) from public;
grant execute on function match_faq(uuid, extensions.vector, int, double precision) to drig_app;
