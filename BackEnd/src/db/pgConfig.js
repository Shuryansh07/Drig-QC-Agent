import fs from "node:fs";

// RDS requires TLS and signs with Amazon's own CA, which Node does not trust by
// default. Set DB_SSL_CA_PATH to the RDS global bundle for full verification.
// Non-RDS hosts (Supabase) keep pg's default behaviour untouched.
export function isRdsHost(connectionString) {
  return new URL(connectionString).hostname.endsWith(".rds.amazonaws.com");
}

export function buildPgConfig(connectionString, warn = console.warn) {
  const caPath = process.env.DB_SSL_CA_PATH;
  if (!caPath && !isRdsHost(connectionString)) return { connectionString };

  // pg lets a sslmode in the URL override the ssl option, so strip it.
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");

  if (caPath) {
    return {
      connectionString: url.toString(),
      ssl: { ca: fs.readFileSync(caPath, "utf8"), rejectUnauthorized: true },
    };
  }

  warn(
    "Connecting to RDS with TLS but WITHOUT certificate verification. Set DB_SSL_CA_PATH to the RDS " +
      "global-bundle.pem (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) to verify the server."
  );
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: false } };
}
