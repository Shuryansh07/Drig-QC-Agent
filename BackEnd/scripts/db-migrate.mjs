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

const connectionString = process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL_ADMIN (or DATABASE_URL) before running this script");

const client = new pg.Client({ connectionString });
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

const secFile = path.resolve("db/platform/supabase/20260921000900_supabase_security.sql");
await run("supabase_security (rerun after any migration that adds a table)", await fs.readFile(secFile, "utf8"));

await client.end();
console.log("\nAll migrations applied.");
