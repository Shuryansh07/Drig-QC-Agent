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
