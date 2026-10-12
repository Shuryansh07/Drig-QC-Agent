import fs from "node:fs";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// RDS requires TLS and signs with Amazon's own CA, which Node does not trust by
// default. Set DB_SSL_CA_PATH to the RDS global bundle for full verification.
// Non-RDS hosts (Supabase) keep pg's default behaviour untouched.
export function isRdsHost(connectionString) {
  return new URL(connectionString).hostname.endsWith(".rds.amazonaws.com");
}

// ---------------------------------------------------------------------------
// Password from AWS Secrets Manager
//
// RDS can rotate its password on a schedule (the managed master secret does,
// every 7 days). A password written into DATABASE_URL goes stale the day that
// happens. With a secret id the URL carries no password at all: each new
// connection asks for the current one instead, so a rotation needs no edit and
// no restart.
//
//   DB_SECRET_ARN        secret for DATABASE_URL        (the app, drig_app)
//   DB_ADMIN_SECRET_ARN  secret for DATABASE_URL_ADMIN  (migrations, scripts)
//
// The secret is JSON with a "password" field, as RDS and "Credentials for RDS
// database" secrets are. The user always comes from the URL: the managed secret
// belongs to the master user, and the app must connect as its own role.
// Credentials: the usual AWS chain (the task role on ECS; AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY or a profile locally). It needs secretsmanager:GetSecretValue.
// ---------------------------------------------------------------------------

// A rotated password is picked up within this long. Short enough to be invisible, long
// enough that a busy pool does not call Secrets Manager on every connection.
const SECRET_CACHE_MS = parseInt(process.env.DB_SECRET_CACHE_MS || "60000", 10);

let client;
const cache = new Map(); // secretId -> { password, expiresAt }
const inFlight = new Map(); // secretId -> Promise: one fetch, however many connections ask at once

const secretsClient = () => {
  client ??= new SecretsManagerClient({ region: process.env.AWS_REGION || process.env.S3_REGION || "us-east-1" });
  return client;
};

/** The current password in the secret. Cached briefly; `fresh` skips the cache (use after a failed login). */
export const getDbPassword = async (secretId, { fresh = false } = {}) => {
  const hit = cache.get(secretId);
  if (!fresh && hit && hit.expiresAt > Date.now()) return hit.password;
  if (inFlight.has(secretId)) return inFlight.get(secretId);

  const fetching = (async () => {
    const response = await secretsClient().send(new GetSecretValueCommand({ SecretId: secretId }));
    let password;
    try {
      password = JSON.parse(response.SecretString ?? "").password;
    } catch {
      /* not JSON: handled below */
    }
    if (!password) throw new Error(`Secret ${secretId} has no "password" field (expected JSON like {"username": "...", "password": "..."})`);
    cache.set(secretId, { password, expiresAt: Date.now() + SECRET_CACHE_MS });
    return password;
  })().finally(() => inFlight.delete(secretId));

  inFlight.set(secretId, fetching);
  return fetching;
};

const sslFor = (hostIsRds, warn) => {
  const caPath = process.env.DB_SSL_CA_PATH;
  if (caPath) return { ca: fs.readFileSync(caPath, "utf8"), rejectUnauthorized: true };
  if (!hostIsRds) return undefined;
  warn(
    "Connecting to RDS with TLS but WITHOUT certificate verification. Set DB_SSL_CA_PATH to the RDS " +
      "global-bundle.pem (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) to verify the server."
  );
  return { rejectUnauthorized: false };
};

/**
 * Connection settings for pg (Pool or Client).
 * `secretId`: take the password from that Secrets Manager secret instead of the URL.
 */
export function buildPgConfig(connectionString, warn = console.warn, { secretId } = {}) {
  const url = new URL(connectionString);
  const hostIsRds = isRdsHost(connectionString);

  if (secretId) {
    if (!url.username) throw new Error("With a Secrets Manager password the connection URL still needs its user (postgresql://user@host:port/db).");
    // Discrete fields rather than the URL: nothing in a password can then break the parsing,
    // and pg lets `password` be a function asked for on every new connection.
    return {
      host: url.hostname,
      port: url.port ? parseInt(url.port, 10) : 5432,
      database: decodeURIComponent(url.pathname.slice(1)) || undefined,
      user: decodeURIComponent(url.username),
      password: () => getDbPassword(secretId),
      ssl: sslFor(hostIsRds, warn),
    };
  }

  const caPath = process.env.DB_SSL_CA_PATH;
  if (!caPath && !hostIsRds) return { connectionString };

  // pg lets a sslmode in the URL override the ssl option, so strip it.
  url.searchParams.delete("sslmode");
  return { connectionString: url.toString(), ssl: sslFor(hostIsRds, warn) };
}
