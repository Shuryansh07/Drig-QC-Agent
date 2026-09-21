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
