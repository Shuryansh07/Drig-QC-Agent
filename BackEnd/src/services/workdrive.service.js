import { logger } from "../utils/logger.js";
import { withTiming } from "../utils/timing.js";
import { retryWithBackoff } from "../utils/retry.js";
import { kindOfFileName, mimeOfKind } from "./chunking/documentTypes.js";

const ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.com";
const API_BASE = process.env.ZOHO_WORKDRIVE_API || "https://www.zohoapis.com/workdrive/api/v1";
const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const FOLDER_ID = process.env.WORKDRIVE_FOLDER_ID;
const TIMEOUT_MS = parseInt(process.env.WORKDRIVE_TIMEOUT_MS || "60000", 10);
const MAX_RETRIES = parseInt(process.env.WORKDRIVE_MAX_RETRIES || "3", 10);

// Access tokens last 3600s — cache in memory so we don't refresh on every
// upload, only forcing a refresh when Zoho actually returns 401.
let cachedToken = null;

const fetchWithTimeout = async (url, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const getAccessToken = async (forceRefresh = false) => {
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error("Zoho WorkDrive is not configured (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN)");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
  });

  const response = await withTiming("WorkDrive OAuth token refresh", () =>
    fetchWithTimeout(`${ACCOUNTS_DOMAIN}/oauth/v2/token`, { method: "POST", body: params })
  );
  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(`Zoho token refresh failed: ${data.error || response.status}`);
  }

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600_000),
  };

  return cachedToken.accessToken;
};

const doUploadAttempt = async (buffer, uniqueFileName, accessToken) => {
  const form = new FormData();
  form.append("content", new Blob([buffer], { type: mimeOfKind(kindOfFileName(uniqueFileName)) }), uniqueFileName);
  form.append("parent_id", FOLDER_ID);
  form.append("override-name-exist", "false");

  const response = await withTiming(`WorkDrive upload (${uniqueFileName}, ${buffer.length} bytes)`, () =>
    fetchWithTimeout(`${API_BASE}/upload`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      body: form,
    })
  );

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const err = new Error(`WorkDrive upload failed (${response.status}): ${JSON.stringify(data)}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const uploaded = data?.data?.[0]?.attributes;
  const resourceId = uploaded?.resource_id;

  if (!resourceId) {
    throw new Error(`WorkDrive upload response missing resource_id: ${JSON.stringify(data)}`);
  }

  return { workdriveFileId: resourceId, workdriveFolderId: FOLDER_ID, permalink: uploaded.Permalink ?? null };
};

/** Confirms the uploaded file is actually retrievable from WorkDrive (not just that the POST returned 200). */
const verifyUpload = async (resourceId, accessToken) => {
  const response = await withTiming(`WorkDrive verify upload (${resourceId})`, () =>
    fetchWithTimeout(`${API_BASE}/files/${resourceId}`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: "application/vnd.api+json" },
    })
  );

  if (!response.ok) {
    const err = new Error(`WorkDrive upload verification failed (${response.status})`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  if (!data?.data?.id) {
    throw new Error("WorkDrive upload verification: response missing file id");
  }
};

/**
 * Uploads the original file (PDF or Word) to the permanent WorkDrive archive folder, then
 * verifies it landed. Verified against the live API: the upload response's
 * file identifier is data[0].attributes.resource_id — a different shape
 * from the normal GET /files/{id} response, which uses a top-level `id`.
 *
 * Transient failures (429/5xx/timeout) retry with backoff via
 * retryWithBackoff. A 401 (stale cached token) triggers one immediate
 * token refresh + retry, outside the backoff budget, since it's not a
 * transient failure — it's a deterministic fix.
 *
 * The uploaded filename is prefixed with `documentId` so two different
 * documents (e.g. same filename from two different customers) can never
 * collide in WorkDrive — verified by testing that a same-name upload can
 * silently overwrite an existing file, which would let one customer's
 * archived original replace another's.
 *
 * Callers should treat failure here as non-fatal to the RAG pipeline —
 * WorkDrive is the archive copy, not part of the retrieval path — and can
 * call this again later to retry just the archive step (see documents.status
 * `rag_completed`).
 */
export const uploadOriginalFile = async (buffer, fileName, documentId) => {
  if (!FOLDER_ID) {
    throw new Error("WORKDRIVE_FOLDER_ID is not configured");
  }

  const uniqueFileName = `${documentId}__${fileName}`;

  return retryWithBackoff(
    `WorkDrive upload (${fileName})`,
    async () => {
      let accessToken = await getAccessToken();
      let result;

      try {
        result = await doUploadAttempt(buffer, uniqueFileName, accessToken);
      } catch (err) {
        if (err.status === 401) {
          logger.warn("WorkDrive upload got 401 (stale token) — refreshing and retrying once");
          accessToken = await getAccessToken(true);
          result = await doUploadAttempt(buffer, uniqueFileName, accessToken);
        } else {
          throw err;
        }
      }

      await verifyUpload(result.workdriveFileId, accessToken);
      return result;
    },
    { maxRetries: MAX_RETRIES }
  );
};
