// Follows the links in DRIG's wiring guide and brings back the file behind
// each one (a photo, or a guide as PDF). The workbook is uploaded by an admin,
// but its links are still untrusted input to a server-side fetch, so:
//
//   * Only hosts the guide actually uses are fetched, over HTTPS (ALLOWED_HOSTS).
//     Anything else is recorded as "unsupported", never requested. That is the
//     SSRF guard: no link can make the server call an internal address.
//   * Redirects are followed by hand and every hop is checked against the same
//     list (Google serves Drive/Docs downloads from *.googleusercontent.com).
//   * A response is capped in size and time, and its bytes must really be an
//     image or a PDF (magic numbers), whatever Content-Type the server claims.
//   * Directechs pages need a dealer login: skipped as "requires_login", like a
//     Drive file that bounces to a Google sign-in page.

const FETCH_TIMEOUT_MS = parseInt(process.env.DRIG_WIRING_FETCH_TIMEOUT_MS || "30000", 10);
const MAX_BYTES = parseInt(process.env.DRIG_WIRING_FETCH_MAX_BYTES || String(30 * 1024 * 1024), 10);
const MAX_REDIRECTS = 5;
const ATTEMPTS = 3;

const ALLOWED_HOSTS = new Set([
  "storage.googleapis.com",
  "directechs.blob.core.windows.net",
  "drive.google.com",
  "drive.usercontent.google.com",
  "docs.google.com",
  // Only ever reached for an /v3/IMGwires/ photo (classifyLink); its pages need a login and are never fetched.
  "www.wiresheet.com",
]);
const ALLOWED_SUFFIXES = [".googleusercontent.com"];

const isAllowedHost = (host) => ALLOWED_HOSTS.has(host) || ALLOWED_SUFFIXES.some((s) => host.endsWith(s));

// Where Google sends a request for a file that is not shared publicly.
const LOGIN_HOSTS = new Set(["accounts.google.com"]);

const driveFileId = (url) => {
  const byPath = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
  if (byPath) return byPath[1];
  const byQuery = url.searchParams.get("id");
  return byQuery && /^[A-Za-z0-9_-]{10,}$/.test(byQuery) ? byQuery : null;
};

const googleDocId = (url, type) => url.pathname.match(new RegExp(`/${type}/d/([A-Za-z0-9_-]{10,})`))?.[1] ?? null;

/**
 * What a link is and how it would be fetched, without fetching it.
 * @returns {{ kind: string, action: "fetch" | "requires_login" | "icon" | "unsupported", fetchUrl?: string, reason?: string }}
 */
export const classifyLink = (rawUrl) => {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    return { kind: "other", action: "unsupported", reason: "not a valid link" };
  }
  const host = url.hostname.toLowerCase();

  if (host === "directechs.com" || host === "www.directechs.com") {
    return { kind: "directechs", action: "requires_login", reason: "Directechs needs a dealer login" };
  }
  if (host === "wiresheet.com" || host.endsWith(".wiresheet.com")) {
    if (/\/assets\//i.test(url.pathname)) return { kind: "wiresheet_icon", action: "icon", reason: "a Wiresheet icon, not wiring information" };
    // A wire photo DRIG pasted into its own guide: public, and DRIG's chosen picture for that row.
    if (host === "www.wiresheet.com" && url.protocol === "https:" && /^\/v3\/IMGwires\/[\w.-]+\.(?:jpe?g|png)$/i.test(url.pathname)) {
      return { kind: "image", action: "fetch", fetchUrl: url.toString() };
    }
    return { kind: "wiresheet", action: "requires_login", reason: "Wiresheet pages need a login" };
  }
  if (url.protocol !== "https:") return { kind: "other", action: "unsupported", reason: "only https links are fetched" };

  if (host === "storage.googleapis.com" || host === "directechs.blob.core.windows.net") {
    return { kind: "image", action: "fetch", fetchUrl: url.toString() };
  }
  if (host === "drive.google.com") {
    const id = driveFileId(url);
    return id
      ? { kind: "google_drive", action: "fetch", fetchUrl: `https://drive.google.com/uc?export=download&id=${id}` }
      : { kind: "google_drive", action: "unsupported", reason: "a Drive folder or page, not a file" };
  }
  if (host === "docs.google.com") {
    const doc = googleDocId(url, "document");
    if (doc) return { kind: "google_doc", action: "fetch", fetchUrl: `https://docs.google.com/document/d/${doc}/export?format=pdf` };
    const slides = googleDocId(url, "presentation");
    if (slides) return { kind: "google_slides", action: "fetch", fetchUrl: `https://docs.google.com/presentation/d/${slides}/export/pdf` };
    return { kind: "google_doc", action: "unsupported", reason: "only Google Docs and Slides can be exported" };
  }
  return { kind: "other", action: "unsupported", reason: `links to ${host} are not fetched` };
};

/** jpeg / png / gif / webp / pdf from the first bytes, or null. */
export const sniffType = (buffer) => {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", mime: "image/png", ext: "png" };
  if (buffer.subarray(0, 4).toString("latin1") === "GIF8") return { kind: "image", mime: "image/gif", ext: "gif" };
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return { kind: "image", mime: "image/webp", ext: "webp" };
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", mime: "application/pdf", ext: "pdf" };
  return null;
};

class LinkError extends Error {
  constructor(message, { status = "failed", retryable = false } = {}) {
    super(message);
    this.linkStatus = status;
    this.retryable = retryable;
  }
}

const readCapped = async (response) => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new LinkError(`file is larger than ${Math.round(MAX_BYTES / 1048576)} MB`);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new LinkError(`file is larger than ${Math.round(MAX_BYTES / 1048576)} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const fetchOnce = async (startUrl) => {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (LOGIN_HOSTS.has(host)) throw new LinkError("the file is not shared publicly (Google sign-in required)", { status: "requires_login" });
    if (parsed.protocol !== "https:" || !isAllowedHost(host)) throw new LinkError(`redirected to ${host}, which is not an allowed host`, { status: "unsupported" });

    let response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: "image/*,application/pdf;q=0.9,*/*;q=0.1", "User-Agent": "DRIG-QC-wiring-import/1.0" },
      });
    } catch (err) {
      throw new LinkError(`could not reach ${host} (${err.name === "TimeoutError" ? "timed out" : err.message})`, { retryable: true });
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new LinkError(`redirect from ${host} had no destination`);
      url = new URL(location, url).toString();
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new LinkError(`access denied by ${host} (HTTP ${response.status})`, { status: "requires_login" });
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      throw new LinkError(`the file no longer exists (HTTP ${response.status})`);
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new LinkError(`${host} answered HTTP ${response.status}`, { retryable: true });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new LinkError(`${host} answered HTTP ${response.status}`);
    }

    const buffer = await readCapped(response);
    const type = sniffType(buffer);
    if (!type) {
      // Drive answers an HTML page for a file too big to virus-scan, a deleted file, or one that is not public.
      const looksHtml = /^\s*</.test(buffer.subarray(0, 64).toString("utf8"));
      throw new LinkError(looksHtml ? "the link opens a web page, not a file (it may not be shared publicly)" : "the file is not an image or a PDF", {
        status: "unsupported",
      });
    }
    return { buffer, ...type, finalHost: host };
  }
  throw new LinkError("too many redirects");
};

/**
 * Downloads one classified link.
 * @returns {Promise<{ ok: true, buffer: Buffer, kind: "image"|"pdf", mime: string, ext: string } | { ok: false, status: string, error: string }>}
 */
export const fetchLinkedFile = async (fetchUrl) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, ...(await fetchOnce(fetchUrl)) };
    } catch (err) {
      const linkErr = err instanceof LinkError ? err : new LinkError(err.message || String(err), { retryable: true });
      if (!linkErr.retryable || attempt >= ATTEMPTS) return { ok: false, status: linkErr.linkStatus, error: linkErr.message.slice(0, 500) };
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
};
