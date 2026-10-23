# node:22-slim (Debian) rather than alpine: sharp's prebuilt binaries are most
# reliable on glibc, and pg / the AWS SDK are pure JS. npm ci runs INSIDE the
# image so sharp gets the linux build for the target platform, never the host's.
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching; only package files invalidate it.
COPY package*.json ./
RUN npm ci --omit=dev

# Just the source — node_modules/.env/data are excluded by .dockerignore.
COPY scrape.mjs db.mjs ./

# Config comes entirely from the ECS task definition's environment
# (WIRESHEET_DATABASE_URL, DB_SECRET_ARN, WIRESHEET_PASSWORD, S3_WIRESHEET_BUCKET,
# S3_REGION, ...). No .env file in the image, so scrape.mjs reads process.env
# directly — do NOT pass --env-file here.
#
# TLS to RDS: DB_SSL_CA_PATH is intentionally unset, so the DB connects over TLS
# without certificate verification (fine inside the VPC). To verify the server
# cert instead, bake the RDS global bundle into the image and set DB_SSL_CA_PATH.

# The scheduled task / backfill passes args (e.g. --delay 6000, --make Acura).
# With no args it runs the full crawl, resuming from the database.
ENTRYPOINT ["node", "scrape.mjs"]
