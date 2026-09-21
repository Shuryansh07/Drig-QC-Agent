# Supabase + vector database setup: prompt for Claude Code

**How to use:** put `DATABASE.md` in the repo root and the `db/` folder beside
it. Open Claude Code in the repo root, then paste the prompts below **one
phase at a time**. Review each phase's result before sending the next one. Each
phase ends at a point you can check, so problems surface before the next step
builds on them.

---

## Phase 0: Read and confirm (no code)

```
Read DATABASE.md in full, then every file under db/. Do not write or change
anything yet.

Then tell me:
1. In your own words, the eight portability rules (section 2) and why each
   one exists.
2. Why the pgvector settings live on the SQL functions instead of in a session
   SET or a database default.
3. Which files run on Supabase and which on AWS, and in what order.
4. Anything in DATABASE.md or db/ that looks inconsistent or unclear.
5. Which commands you expect to run in later phases that could change a
   remote database. Those will need my approval.

We are on Supabase now and moving to AWS RDS later. Every decision you make
must keep that move cheap.
```

---

## Phase 1: Preflight checks (no changes)

```
Check the environment. Report results; change nothing.

1. Supabase CLI installed? Run `supabase --version`. Docker running (needed
   for the local stack)?
2. Ask me for the Supabase project ref and region if they are not in the
   repo's .env.example.
3. Using the direct or session-pooler connection string I give you, run
   (read-only):
     select version();
     select name, default_version, installed_version
       from pg_available_extensions where name in ('vector', 'pg_trgm');
4. If the available pgvector version is below 0.8.0, STOP. Tell me to upgrade
   the project's Postgres version under Project Settings > Infrastructure,
   and do not continue. The first migration will refuse to run anyway,
   because the retrieval design depends on hnsw.iterative_scan.
5. Tell me whether this machine has IPv6. If it doesn't, use the session
   pooler (port 5432 on the pooler host) instead of the direct connection.
```

---

## Phase 2: Wire the migrations into the Supabase CLI

```
Set up the migration layout. Portable SQL stays in db/; Supabase's folder is
generated from it.

1. If supabase/ does not exist, run `supabase init`. Do not change
   supabase/config.toml beyond what init creates, unless you ask me first.
2. Write scripts/db-sync-supabase.mjs, a cross-platform Node script with no
   dependencies. It must:
     - delete supabase/migrations/*.sql
     - copy db/migrations/*.sql and db/platform/supabase/*.sql into
       supabase/migrations/, keeping the filenames
     - print the list it copied, in order
   The files are already named <14-digit timestamp>_<name>.sql as the CLI expects.
3. Add package.json scripts:
     "db:sync":   "node scripts/db-sync-supabase.mjs"
     "db:reset":  "npm run db:sync && supabase db reset"
     "db:push":   "npm run db:sync && supabase db push"
     "db:verify": "psql \"$DATABASE_URL_ADMIN\" -f db/verify/verify.sql"
   (On Windows, give me the PowerShell equivalent for db:verify.)
4. Add supabase/migrations/ to .gitignore with a comment: "generated from db/
   by npm run db:sync. Edit db/, never this folder."
5. Add .env.example with every variable from DATABASE.md section 3 and
   placeholder values. Make sure .env is gitignored. Never write a real secret
   into any file.

Show me the diff when done.
```

---

## Phase 3: Local stack

```
Bring the schema up locally and verify it.

1. supabase start
2. Check the local pgvector version (same query as Phase 1). If it is below
   0.8.0, set [db] major_version in supabase/config.toml to a version whose
   image ships 0.8.0, and ask me before changing it.
3. npm run db:reset. This applies all migrations to the LOCAL database only.
4. Run db/verify/verify.sql against the local database (use the DB URL from
   `supabase status`). Every row must be PASS or INFO. Show me the full output.
5. Smoke test, as the local admin user:
     select * from run_wiring_validation(
       (select org_id from organization), 1);
   It should return rule rows with 0 affected on the empty table, without error.
6. Set a local-only password for drig_app
   (alter role drig_app password 'local-dev-only'), connect as drig_app, and
   confirm `select count(*) from setting;` returns 20.
7. As the local ADMIN user (not drig_app, which cannot switch to anon), run:
     set role anon; select * from kb_chunk;
   It must fail with "permission denied for table kb_chunk". Any other error,
   or any rows returned, means the RLS lockout did not apply.
```

---

## Phase 4: Push to the remote project (needs my approval)

```
Apply the schema to the remote Supabase project.

1. supabase link --project-ref <ref>. Ask me for the ref if you don't have it.
2. supabase db push --dry-run. Show me the list of migrations it would apply
   and WAIT for my explicit "go" before pushing.
3. After I approve: npm run db:push.
4. Run verify.sql against the remote using DATABASE_URL_ADMIN. Show me the
   output. Sections 1 and 2 must be PASS. If section 2 fails, the pgvector
   settings did not apply, so stop and tell me.
5. Tell me the exact SQL to set drig_app's password. I will run it myself with
   a generated secret; do not generate, echo or store the password.
6. Once I confirm, test that drig_app can log in through the SESSION pooler as
   drig_app.<project-ref>. If the pooler rejects the custom role, stop and
   report the exact error; do not fall back to the postgres user.

Never run `supabase db reset` against the linked remote project.
```

---

## Phase 5: Data access layer

```
Build the backend's data access layer. Plain Postgres driver only. No
supabase-js and no PostgREST, per portability rule P1.

1. src/db/pool.ts
   - node-postgres (pg) Pool from DATABASE_URL, max 10.
   - Refuse to start if DATABASE_URL's user is postgres, supabase_admin or
     drigadmin (rule P6).
   - If the URL points at port 6543 (transaction pooler), log a warning and make
     sure no named prepared statements are used anywhere.
2. src/db/vector.ts
   - Use the `pgvector` npm package to serialise number[] for queries.
   - Assert the array length is 1536 before sending it.
3. src/db/retrieval.ts, typed wrappers, one per SQL function:
     matchChunks, matchCallCards, lookupWiring, imagesForChunks
   - Always call with named parameters (p_org_id => $1 ...).
   - Return typed rows exactly as the functions return them.
   - NEVER write the <=> operator or query kb_chunk.embedding directly
     (rule P5). Add an ESLint no-restricted-syntax rule, or a unit test that
     greps src/ for "<=>", so this cannot regress.
4. src/db/ingestion.ts: publishDocumentVersion, retireDocument,
   runWiringValidation, publishWiringVersion.
5. src/db/settings.ts: load `setting` rows for the org and workflow and cache
   them for 5 minutes. Typed getters. No threshold, model name or regex may be
   a constant anywhere in src/ (INV-4).
6. Integration tests against the LOCAL stack (never the remote):
   - lookupWiring for a year not in the table returns []
   - a quarantined row comes back with cellRaw === null
   - matchChunks returns rows with denseSimilarity between 0 and 1
   - the approval trigger rejects a card going live without review
   - anon cannot read kb_chunk

If any job code is in Python, mirror the same wrappers with psycopg and
pgvector-python. Same rules apply.
```

---

## Phase 6: Storage and auth adapters

```
1. src/storage/objectStore.ts using @aws-sdk/client-s3:
   - endpoint from S3_ENDPOINT (unset on AWS), region S3_REGION,
     forcePathStyle from S3_FORCE_PATH_STYLE.
   - put(key, body, contentType), getSignedUrl(key, 300 seconds), delete(key).
   - Create a PRIVATE bucket named by S3_BUCKET in Supabase Storage. Give me
     the steps; do not make it public.
   - The database stores keys only. Never store URLs or bucket names in rows.
   - S3 keys bypass RLS: server-side only. Add a check that fails the web
     build if S3_SECRET_ACCESS_KEY is referenced anywhere under the web app.
2. src/auth/verifyToken.ts:
   - Verify the bearer JWT against AUTH_JWKS_URL and AUTH_ISSUER with the
     `jose` library.
   - Map to person via (org_id, auth_provider = AUTH_PROVIDER,
     external_ref = sub).
   - Load permissions through person_role -> app_role_permission -> permission.
     Check permission codes (knowledge.upload etc.), never role names.
   - If the Supabase project still uses the legacy shared JWT secret instead
     of signing keys, tell me. Do not hardcode the secret.

Nothing in this phase may import @supabase/supabase-js.
```

---

## Guardrails for every phase

```
- Never edit a migration that has been applied to any database. Add a new
  timestamped file in db/migrations/ instead, then update DATABASE.md in the
  same change.
- Never change the schema through the Supabase dashboard.
- Any new table: org_id column, RLS plus policies (or rerun
  db/platform/supabase/*security.sql), and a verify.sql check if it holds
  knowledge.
- Any new vector query: a SQL function carrying the same SET clauses as
  match_chunks, plus an entry in verify.sql section 2.
- Ask before any command that changes the remote database. Never run
  destructive commands against the remote.
- Never commit, print or log secrets or passwords.
- When unsure whether something is Supabase-only, assume it is and ask.
```

---

## Done when

- [ ] `verify.sql` passes on the remote Supabase project (sections 1–8 PASS)
- [ ] `drig_app` connects through the session pooler; the API never uses an admin user
- [ ] `anon` cannot read any table (verify.sql section 7)
- [ ] No `supabase-js` import and no `<=>` anywhere in `src/`
- [ ] Integration tests pass against the local stack
- [ ] Storage is a private bucket reached only through the S3 adapter
- [ ] `.env.example` complete; no secrets in git
