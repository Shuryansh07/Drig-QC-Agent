import { Pool } from "pg";
import { logger } from "../utils/logger.js";

// Portability rule P1 (Plan/DATABASE.md): a plain Postgres driver only. No
// supabase-js, no PostgREST. Rule P6: the app connects as drig_app on every
// platform, never as an admin user — the admin user runs migrations only.
const FORBIDDEN_USERS = new Set(["postgres", "supabase_admin", "drigadmin"]);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const parsed = new URL(connectionString);
// Pooler usernames take the form `<role>.<project-ref>` (DATABASE.md §3), so
// the forbidden check is against the role prefix, not the raw username.
const role = decodeURIComponent(parsed.username).split(".")[0];
if (FORBIDDEN_USERS.has(role)) {
  throw new Error(
    `DATABASE_URL user "${parsed.username}" is an admin role. The API process must connect as drig_app ` +
      "(rule P6) — migrations run separately as the admin user via DATABASE_URL_ADMIN."
  );
}

// Rule §3: on the transaction pooler (port 6543), session state (including
// prepared statements) does not survive between transactions.
if (parsed.port === "6543") {
  logger.warn(
    "DATABASE_URL points at port 6543 (Supabase transaction pooler). Session state does not persist " +
      "between transactions on this pooler — named prepared statements must not be used anywhere."
  );
}

export const pool = new Pool({ connectionString, max: 10 });

pool.on("error", (err) => {
  logger.error("Unexpected error on idle pg client", err);
});
