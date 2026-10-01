import fs from "node:fs";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

// The API and the worker are separate processes (separate containers on ECS), so an
// uploaded file cannot be handed over on local disk. The API puts it in S3 and the
// worker reads it back. Credentials come from the default AWS chain: AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY (or a profile) locally, the task role on ECS.
const REGION = process.env.S3_REGION || process.env.AWS_REGION || "us-east-1";

let client;
const s3 = () => (client ??= new S3Client({ region: REGION }));

const bucket = () => {
  const name = process.env.S3_BUCKET;
  if (!name) throw new Error("S3_BUCKET is not configured");
  return name;
};

export const UPLOAD_PREFIX = process.env.S3_UPLOAD_PREFIX || "uploads/";

const isNotFound = (err) => err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;

/** Streams a local file to S3 under `key`. */
export const putFile = async (key, localPath, contentType) => {
  const { size } = await fs.promises.stat(localPath);
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentLength: size,
      ...(contentType && { ContentType: contentType }),
    })
  );
};

/** Whole object as a Buffer. Throws an error with code ENOENT when the key does not exist. */
export const getBuffer = async (key) => {
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return Buffer.from(await res.Body.transformToByteArray());
  } catch (err) {
    if (isNotFound(err)) throw Object.assign(new Error(`Stored file not found in S3: ${key}`), { code: "ENOENT" });
    throw err;
  }
};

export const exists = async (key) => {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
};

/** Deleting a missing key is not an error in S3. */
export const remove = async (key) => {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
};

/** Every object under `prefix` as { key, lastModified }. */
export const list = async (prefix) => {
  const out = [];
  let ContinuationToken;
  do {
    const res = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken }));
    for (const o of res.Contents ?? []) out.push({ key: o.Key, lastModified: o.LastModified });
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
};
