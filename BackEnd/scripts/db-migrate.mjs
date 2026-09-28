// Applies db/migrations/*.sql (in order) + the Supabase security lockdown
// to whatever DATABASE_URL points at, using a plain `pg` connection. Stand-in
// for `supabase db push` in environments without the Supabase CLI/Docker.
// Connect as the ADMIN user (DATABASE_URL_ADMIN), never drig_app — see
// DATABASE.md rule P6. Never run this against a database with real data
// without reading db/verify's checks first.
import "dotenv/config";
import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { buildPgConfig, isRdsHost } from "../src/db/pgConfig.js";

const connectionString = process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL_ADMIN (or DATABASE_URL) before running this script");

const platform =
  process.env.DB_PLATFORM || (isRdsHost(connectionString) ? "aws" : "supabase");
if (!["aws", "supabase"].includes(platform)) throw new Error(`DB_PLATFORM must be aws or supabase, got "${platform}"`);
console.log(`Platform: ${platform}`);

const client = new pg.Client(buildPgConfig(connectionString));
await client.connect();

const run = async (label, sql) => {
  console.log(`\n--- ${label} ---`);
  await client.query(sql);
  console.log(`OK: ${label}`);
};

const migDir = path.resolve("db/migrations");
const migFiles = (await fs.readdir(migDir)).filter((f) => f.endsWith(".sql")).sort();
for (const f of migFiles) {
  await run(f, await fs.readFile(path.join(migDir, f), "utf8"));
}

const platformFile =
  platform === "aws"
    ? "db/platform/aws/20260921000900_aws_platform.sql"
    : "db/platform/supabase/20260921000900_supabase_security.sql";
await run(`${platform} platform (rerun after any migration that adds a table)`, await fs.readFile(path.resolve(platformFile), "utf8"));

// A role granted rds_iam can ONLY log in with an IAM token; its password stops working.
// Keep password login unless the app is set up for IAM auth (DB_IAM_AUTH=true).
if (platform === "aws" && process.env.DB_IAM_AUTH !== "true") {
  await run(
    "revoke rds_iam from drig_app (password login)",
    `do $$ begin
       if exists (select 1 from pg_roles where rolname = 'rds_iam')
          and pg_has_role('drig_app', 'rds_iam', 'member') then
         revoke rds_iam from drig_app;
       end if;
     end $$;`
  );
}

await client.end();
console.log("\nAll migrations applied.");
