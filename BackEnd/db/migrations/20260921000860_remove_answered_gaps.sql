-- ============================================================================
-- 0860  Remove gaps an admin answered                PORTABLE: Supabase + RDS
-- ============================================================================
-- kb_gap records every question the assistant refused. Once an admin writes the
-- answer (faq_entry, source 'admin'), the refusals of that question are no
-- longer gaps: this deletes the open ones whose question is at least
-- p_min_similarity (cosine) to the answered question. The vector operator stays
-- in SQL (rule P5).
-- ============================================================================

create or replace function remove_answered_gaps(
  p_org_id          uuid,
  p_query_embedding extensions.vector(1536),
  p_min_similarity  double precision
)
returns int
language sql
volatile
set search_path = public, extensions
as $$
  with removed as (
    delete from kb_gap g
     where g.org_id = p_org_id
       and g.status = 'open'
       and g.query_vec is not null
       and 1 - (g.query_vec <=> p_query_embedding) >= p_min_similarity
    returning 1
  )
  select count(*)::int from removed;
$$;

revoke execute on function remove_answered_gaps(uuid, extensions.vector, double precision) from public;
grant execute on function remove_answered_gaps(uuid, extensions.vector, double precision) to drig_app;
