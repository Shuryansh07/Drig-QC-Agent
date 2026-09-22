/**
 * The file types the ingestion pipeline understands. One place, so the upload
 * filter, the content check, the parser choice and the WorkDrive mime type
 * cannot drift apart.
 *
 * Old binary Word files (.doc) are deliberately NOT supported: they are a
 * different format that no lightweight parser reads reliably. The upload
 * error tells the admin to save as .docx instead.
 */
const KINDS = {
  pdf: {
    label: "PDF",
    extension: ".pdf",
    mime: "application/pdf",
    // "%PDF"
    magic: [0x25, 0x50, 0x44, 0x46],
  },
  docx: {
    label: "Word document",
    extension: ".docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    // A .docx is a zip container: "PK\x03\x04"
    magic: [0x50, 0x4b, 0x03, 0x04],
  },
};

export const SUPPORTED_EXTENSIONS = Object.values(KINDS).map((k) => k.extension);

/** 'pdf' | 'docx' | null, from the file name. */
export const kindOfFileName = (fileName) => {
  const name = String(fileName ?? "").toLowerCase();
  return Object.entries(KINDS).find(([, k]) => name.endsWith(k.extension))?.[0] ?? null;
};

export const describeKind = (kind) => KINDS[kind]?.label ?? "file";
export const mimeOfKind = (kind) => KINDS[kind]?.mime ?? "application/octet-stream";
export const extensionOfKind = (kind) => KINDS[kind]?.extension ?? "";

/** True when the bytes start like the claimed type, so a renamed file is caught at upload, not after three failed jobs. */
export const bufferMatchesKind = (buffer, kind) => {
  const magic = KINDS[kind]?.magic;
  return Boolean(magic) && buffer.length >= magic.length && magic.every((byte, i) => buffer[i] === byte);
};

export const unsupportedTypeMessage = (fileName) =>
  String(fileName ?? "").toLowerCase().endsWith(".doc")
    ? "Old .doc files are not supported. Open it in Word and save it as .docx, then upload that."
    : "Only PDF and Word (.docx) files can be uploaded.";
