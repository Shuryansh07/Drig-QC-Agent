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
