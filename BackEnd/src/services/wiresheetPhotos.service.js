import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Wiresheet photos live in their own bucket (qc-wiresheet), separate from the
// knowledge-base bucket in storage.service.js. The scraper uploads them; here
// the API only reads them for the Excel export. Credentials come from the
// default AWS chain (the API task role on ECS) — that role needs s3:GetObject
// on this bucket for both the thumbnail fetch and the signed links to work.
const REGION = process.env.S3_REGION || process.env.AWS_REGION || "us-east-1";
const BUCKET = process.env.S3_WIRESHEET_BUCKET || "qc-wiresheet";
const LINK_DAYS = Number(process.env.WIRESHEET_REPORT_LINK_DAYS || "7");

let client;
const s3 = () => (client ??= new S3Client({ region: REGION }));

/** A time-limited link to the full-size photo. Null on any failure, so the export degrades to "no link" rather than erroring. */
export const signPhotoUrl = async (s3Key) => {
  if (!s3Key) return null;
  try {
    return await getSignedUrl(s3(), new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }), { expiresIn: LINK_DAYS * 86_400 });
  } catch {
    return null;
  }
};

/** The thumbnail bytes for embedding in a cell. Null if the key is missing or S3 can't be reached (the row falls back to a text link). */
export const getThumbBuffer = async (thumbKey) => {
  if (!thumbKey) return null;
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: thumbKey }));
    return Buffer.from(await res.Body.transformToByteArray());
  } catch {
    return null;
  }
};
