-- ============================================================================
-- 0100  Extensions                                   PORTABLE: Supabase + RDS
-- ============================================================================
-- Extensions live in schema `extensions`, never `public`. That is Supabase's
-- convention; we adopt it on RDS too so every other migration is identical.
-- Everything that uses an extension type or opclass qualifies it:
--   extensions.vector(1536)   extensions.vector_cosine_ops   extensions.gin_trgm_ops
-- gen_random_uuid() is built into Postgres 13+, so pgcrypto is not needed.
-- ============================================================================

create schema if not exists extensions;

create extension if not exists vector  with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- If an extension was enabled earlier from a dashboard it may sit in `public`.
-- Both are relocatable, so move them rather than fail later on a type lookup.
do $$
begin
  if (select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
       where e.extname = 'vector') <> 'extensions' then
    alter extension vector set schema extensions;
  end if;
  if (select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
       where e.extname = 'pg_trgm') <> 'extensions' then
    alter extension pg_trgm set schema extensions;
  end if;
end $$;

-- Hard stop below pgvector 0.8.0. hnsw.iterative_scan arrived in 0.8.0 and the
-- retrieval functions depend on it to avoid silently returning too few rows.
do $$
declare v text;
begin
  select extversion into v from pg_extension where extname = 'vector';
  if string_to_array(v, '.')::int[] < array[0,8,0] then
    raise exception using
      message = format('pgvector %s is too old: 0.8.0 or newer is required (hnsw.iterative_scan).', v),
      hint    = 'Supabase: Project Settings > Infrastructure > upgrade the Postgres version. '
             || 'RDS: engine 17.1+, 16.5+, 15.9+, 14.14+ or 13.17+.';
  end if;
end $$;
