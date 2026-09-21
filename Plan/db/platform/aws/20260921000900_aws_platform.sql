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
