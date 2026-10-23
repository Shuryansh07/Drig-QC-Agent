// Postgres persistence for the scraper: progress ledger + scraped data + image
// dedup, all the state that used to live in done.json / vehicles.jsonl /
// uploaded-images.json. On Fargate the task's disk is wiped when it exits, so
// this is what lets a restart (or the weekly run) resume where it left off.
//
// Connects as drig_app, same as the API (never the admin role). The DB password
// comes from AWS Secrets Manager (DB_SECRET_ARN) — asked for on each new
// connection, so an RDS rotation needs no change here. (The Wiresheet dealer
// LOGIN password is separate and comes from the env, WIRESHEET_PASSWORD.) A
// password in WIRESHEET_DB_PASSWORD / the URL is a local-dev fallback only.
import fs from "node:fs";
import pg from "pg";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const ORG_NAME = process.env.WIRESHEET_ORG_NAME || "DRIG USA";

const isRdsHost = (url) => new URL(url).hostname.endsWith(".rds.amazonaws.com");

// The secret's whole JSON, cached briefly so a reconnect does not call Secrets
// Manager every time and a rotation is picked up within the TTL. An RDS-managed
// secret has { username, password }; some secrets also carry host/port/dbname.
const SECRET_CACHE_MS = 60_000;
let secretClient;
let secretCache = null; // { data, expiresAt }
const getSecret = async (secretId) => {
  if (secretCache && secretCache.expiresAt > Date.now()) return secretCache.data;
  secretClient ??= new SecretsManagerClient({ region: process.env.AWS_REGION || process.env.S3_REGION || "us-east-1" });
  const res = await secretClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  const data = JSON.parse(res.SecretString ?? "{}");
  if (!data.password) throw new Error(`Secret ${secretId} has no "password" field (expected JSON like {"username":"...","password":"..."}).`);
  secretCache = { data, expiresAt: Date.now() + SECRET_CACHE_MS };
  return data;
};

const sslFor = (host) => {
  const caPath = process.env.DB_SSL_CA_PATH;
  if (caPath) return { ca: fs.readFileSync(caPath, "utf8"), rejectUnauthorized: true };
  if (host.endsWith(".rds.amazonaws.com")) return { rejectUnauthorized: false }; // RDS needs TLS; skip cert verify inside the VPC
  return undefined;
};

let pool;
let orgId;

/**
 * Connection config. The server (host/port/db/user) comes from the URL, or from
 * the secret when the secret includes those fields and no URL is given. The
 * password comes from Secrets Manager (DB_SECRET_ARN) as a function pg calls on
 * every new connection, so a rotation needs no restart; without an ARN it falls
 * back to WIRESHEET_DB_PASSWORD / the URL password (local dev only).
 */
const resolveConfig = async () => {
  const connectionString = process.env.WIRESHEET_DATABASE_URL || process.env.DATABASE_URL;
  const secretId = process.env.DB_SECRET_ARN;
  const password = secretId
    ? async () => (await getSecret(secretId)).password
    : process.env.WIRESHEET_DB_PASSWORD || undefined;

  if (connectionString) {
    const url = new URL(connectionString);
    return {
      host: url.hostname,
      port: url.port ? parseInt(url.port, 10) : 5432,
      database: decodeURIComponent(url.pathname.slice(1)) || "postgres",
      user: decodeURIComponent(url.username),
      password: password ?? (url.password ? decodeURIComponent(url.password) : undefined),
      ssl: sslFor(url.hostname),
    };
  }

  // No URL: the secret must also carry the server details (an RDS-managed secret does NOT).
  if (secretId) {
    const s = await getSecret(secretId);
    if (!s.host) {
      throw new Error(
        "DB_SECRET_ARN is set but the secret has no host — it only carries the password. " +
          "Also set WIRESHEET_DATABASE_URL=postgresql://<user>@<host>:5432/<db> (no password). " +
          "The RDS-managed secret never includes the host, which is why the URL is still needed."
      );
    }
    return {
      host: s.host,
      port: s.port ? parseInt(s.port, 10) : 5432,
      database: s.dbname || s.database || "postgres",
      user: s.username,
      password,
      ssl: sslFor(String(s.host)),
    };
  }

  throw new Error(
    "Set WIRESHEET_DATABASE_URL=postgresql://<user>@<host>:5432/<db> (the DB password comes from DB_SECRET_ARN). See .env.example."
  );
};

export const connect = async () => {
  pool = new pg.Pool({ ...(await resolveConfig()), max: 4 });
  const { rows } = await pool.query(`select org_id from organization where name = $1`, [ORG_NAME]);
  if (!rows[0]) throw new Error(`No organization "${ORG_NAME}" in the database (run the backend migrations first).`);
  orgId = rows[0].org_id;
  return pool;
};

export const close = async () => {
  await pool?.end().catch(() => {});
};

// --- Progress ledger (was done.json) -------------------------------------

/** The set of finished "make|year|model" (and "make|-|-", "make|year|-") keys, like the old done set. */
export const loadDoneCombos = async () => {
  const { rows } = await pool.query(
    `select make, year, model from wiresheet_scrape_combo where org_id = $1`,
    [orgId]
  );
  // '' is stored for a missing year/model level; map it back to the '-' the crawl uses in its keys.
  return new Set(rows.map((r) => `${r.make}|${r.year || "-"}|${r.model || "-"}`));
};

export const markCombo = async (make, year, model, state = "done") => {
  await pool.query(
    `insert into wiresheet_scrape_combo (org_id, make, year, model, state, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (org_id, make, year, model)
     do update set state = excluded.state, updated_at = now()`,
    [orgId, make, year ?? "", model ?? "", state]
  );
};

// --- Scraped vehicles (was vehicles.jsonl) -------------------------------

/** "make|year|model|recnum" of every vehicle already recorded (not as an error), so a rerun skips them. */
export const loadRecordedKeys = async () => {
  const { rows } = await pool.query(
    `select make, year, model, recnum from wiresheet_vehicle
      where org_id = $1 and recnum is not null and status <> 'error'`,
    [orgId]
  );
  return new Set(rows.map((r) => `${r.make}|${r.year}|${r.model}|${r.recnum}`));
};

/**
 * Upserts one scraped vehicle and (replacing any previous ones) its wires. A
 * retry after an error overwrites the earlier row. Each wire's image_id links
 * to the photo already stored by storeImage(). Runs in one transaction.
 */
export const recordVehicle = async (rec) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(
      `insert into wiresheet_vehicle
         (org_id, make, year, model, recnum, key_type, title, status,
          found_12v, photo_12v, found_ignition, photo_ignition, error_message, scraped_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), now())
       on conflict (org_id, make, year, model, recnum) do update set
         key_type = excluded.key_type, title = excluded.title, status = excluded.status,
         found_12v = excluded.found_12v, photo_12v = excluded.photo_12v,
         found_ignition = excluded.found_ignition, photo_ignition = excluded.photo_ignition,
         error_message = excluded.error_message, updated_at = now()
       returning vehicle_id`,
      [
        orgId, rec.make, String(rec.year), rec.model, rec.recnum ?? null, rec.keyType ?? null,
        rec.title ?? null, rec.status, !!rec.found12v, !!rec.photo12v, !!rec.foundIgnition,
        !!rec.photoIgnition, rec.problem ?? null,
      ]
    );
    const vehicleId = rows[0].vehicle_id;

    await client.query(`delete from wiresheet_entry where vehicle_id = $1`, [vehicleId]);
    let ordinal = 0;
    for (const w of rec.wires ?? []) {
      ordinal += 1;
      await client.query(
        `insert into wiresheet_entry
           (org_id, vehicle_id, ordinal, circuit, section, function_name, wire_colour, polarity, location, notes, cell_raw, image_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          orgId, vehicleId, ordinal, w.circuit ?? "other", w.section ?? null, w.function ?? null,
          w.color ?? null, w.polarity ?? null, w.location ?? null, w.notes || null,
          w.cellRaw ?? describeRaw(w), w.imageId ?? null,
        ]
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/** A verbatim one-line form of a wire, used as cell_raw when the caller did not supply one. */
const describeRaw = (w) =>
  `${w.function}: ${[w.color, w.polarity, w.location].filter((p) => p && p.toLowerCase() !== "null").join(" ")}${w.notes ? ` (${w.notes})` : ""}`;

// --- Image dedup (was uploaded-images.json) ------------------------------

/** image rec ({ imageId, s3Key, thumbKey, contentHash, width, height }) for a source URL already fetched, or null. */
export const imageBySourceUrl = async (url) => {
  const { rows } = await pool.query(
    `select i.image_id, i.content_hash, i.s3_key, i.thumb_key, i.width, i.height
       from wiresheet_image_source s join wiresheet_image i on i.image_id = s.image_id
      where s.org_id = $1 and s.source_url = $2`,
    [orgId, url]
  );
  return rows[0] ? toImageRec(rows[0]) : null;
};

/** image rec for a content hash already stored, or null (different URL, same bytes). */
export const imageByHash = async (hash) => {
  const { rows } = await pool.query(
    `select image_id, content_hash, s3_key, thumb_key, width, height
       from wiresheet_image where org_id = $1 and content_hash = $2`,
    [orgId, hash]
  );
  return rows[0] ? toImageRec(rows[0]) : null;
};

/** Stores a newly uploaded image and maps the source URL to it. Returns its image rec. */
export const insertImage = async ({ contentHash, s3Key, thumbKey, width, height, sourceUrl }) => {
  const { rows } = await pool.query(
    `insert into wiresheet_image (org_id, content_hash, s3_key, thumb_key, width, height)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (org_id, content_hash) do update set
       s3_key = excluded.s3_key, thumb_key = coalesce(excluded.thumb_key, wiresheet_image.thumb_key)
     returning image_id, content_hash, s3_key, thumb_key, width, height`,
    [orgId, contentHash, s3Key, thumbKey ?? null, width ?? null, height ?? null]
  );
  const rec = toImageRec(rows[0]);
  await mapSourceUrl(sourceUrl, rec.imageId);
  return rec;
};

export const mapSourceUrl = async (url, imageId) => {
  await pool.query(
    `insert into wiresheet_image_source (org_id, source_url, image_id)
     values ($1,$2,$3) on conflict (org_id, source_url) do nothing`,
    [orgId, url, imageId]
  );
};

const toImageRec = (r) => ({
  imageId: r.image_id,
  contentHash: r.content_hash,
  s3Key: r.s3_key,
  thumbKey: r.thumb_key,
  width: r.width,
  height: r.height,
});

// --- Report (was reading vehicles.jsonl) ---------------------------------

/**
 * Every scraped vehicle shaped like the old vehicles.jsonl record, so the Excel
 * writer needs almost no change: { make, year, model, keyType, status, wires:[...] }
 * with each wire carrying its photo's keys/hash for the signed-URL links.
 */
export const loadReportRecords = async () => {
  const { rows } = await pool.query(
    `select v.make, v.year, v.model, v.recnum, v.key_type, v.status,
            e.ordinal, e.function_name, e.wire_colour, e.polarity, e.location, e.notes,
            i.s3_key, i.thumb_key, i.content_hash, i.width, i.height
       from wiresheet_vehicle v
       left join wiresheet_entry e on e.vehicle_id = v.vehicle_id
       left join wiresheet_image i on i.image_id = e.image_id
      where v.org_id = $1
      order by v.make, v.year, v.model, v.recnum, e.ordinal`,
    [orgId]
  );
  const byVehicle = new Map();
  for (const r of rows) {
    const key = `${r.make}|${r.year}|${r.model}|${r.recnum ?? r.status}`;
    if (!byVehicle.has(key)) {
      byVehicle.set(key, { make: r.make, year: r.year, model: r.model, keyType: r.key_type, status: r.status, wires: [] });
    }
    if (r.function_name) {
      byVehicle.get(key).wires.push({
        function: r.function_name, color: r.wire_colour, polarity: r.polarity, location: r.location, notes: r.notes,
        imageS3Key: r.s3_key, imageThumbKey: r.thumb_key, imageContentHash: r.content_hash,
        imageWidth: r.width, imageHeight: r.height,
      });
    }
  }
  return [...byVehicle.values()];
};
