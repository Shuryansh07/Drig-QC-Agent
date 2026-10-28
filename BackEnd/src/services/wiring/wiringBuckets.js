import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as kbStorage from "../storage.service.js";

// Evidence images can come from three private buckets:
//   kb          the knowledge-base bucket (storage.service.js): manual figures
//   drig_wiring DRIG's wiring guide photos/guides (drig-qc-wiresheet), written by the importer
//   wiresheet   the scraped Wiresheet photos (qc-wiresheet), written by the scraper
// The database stores object keys only; which bucket a key lives in travels
// with it as one of these names (never a bucket name), and is resolved here
// from configuration. Credentials come from the default AWS chain.
const REGION = process.env.S3_REGION || process.env.AWS_REGION || "us-east-1";

const BUCKETS = {
  drig_wiring: () => process.env.S3_DRIG_WIRING_BUCKET || "drig-qc-wiresheet",
  wiresheet: () => process.env.S3_WIRESHEET_BUCKET || "qc-wiresheet",
};

export const BUCKET_IDS = new Set(["kb", ...Object.keys(BUCKETS)]);

let client;
const s3 = () => (client ??= new S3Client({ region: REGION }));

const bucketOf = (bucketId) => {
  const name = BUCKETS[bucketId]?.();
  if (!name) throw new Error(`Unknown bucket id "${bucketId}"`);
  return name;
};

const isNotFound = (err) => err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;

/** A buffer to the DRIG wiring (or Wiresheet) bucket. A buffer body can be resent, so the SDK's own retries cover it. */
export const putObject = async (bucketId, key, buffer, contentType) => {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucketOf(bucketId),
      Key: key,
      Body: buffer,
      ...(contentType && { ContentType: contentType }),
    })
  );
};

export const getObject = async (bucketId, key) => {
  if (bucketId === "kb") return kbStorage.getBuffer(key);
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: bucketOf(bucketId), Key: key }));
    return Buffer.from(await res.Body.transformToByteArray());
  } catch (err) {
    if (isNotFound(err)) throw Object.assign(new Error(`Stored file not found in S3: ${key}`), { code: "ENOENT" });
    throw err;
  }
};

export const objectExists = async (bucketId, key) => {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucketOf(bucketId), Key: key }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
};

/**
 * A time-limited link the browser can load directly; the buckets stay private.
 * `downloadName` makes the browser save a PDF under a readable name instead of its hash.
 */
export const signUrl = async (bucketId, key, { expiresIn = 3600, downloadName } = {}) => {
  if (bucketId === "kb") return kbStorage.getPresignedUrl(key, expiresIn);
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucketOf(bucketId),
      Key: key,
      ...(downloadName && { ResponseContentDisposition: `inline; filename="${downloadName.replace(/[^\w.() -]+/g, "_")}"` }),
    }),
    { expiresIn }
  );
};
