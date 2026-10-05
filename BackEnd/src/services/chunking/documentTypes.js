/**
 * The file types the ingestion pipeline understands. One place, so the upload
 * filter, the content check, the parser choice and the WorkDrive mime type
 * cannot drift apart.
 *
 * Old binary Word files (.doc) are deliberately NOT supported: they are a
 * different format that no lightweight parser reads reliably. The upload
 * error tells the admin to save as .docx instead.
 *
 * jpg/jpeg/png are a standalone photo or scan with no accompanying manual —
 * e.g. a photo of a wiring diagram, a label, a nameplate. They have no text of
 * their own; imageStructure.js tracks them as a single page with no blocks,
 * and visualEnrichment.js's enrichImage() sends the whole image straight to
 * the vision model so its description becomes the document's only (searchable)
 * content. See isImageKind() below.
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
  jpg: {
    label: "JPEG image",
    extension: ".jpg",
    mime: "image/jpeg",
    // JPEG SOI marker
    magic: [0xff, 0xd8, 0xff],
  },
  jpeg: {
    label: "JPEG image",
    extension: ".jpeg",
    mime: "image/jpeg",
    magic: [0xff, 0xd8, 0xff],
  },
  png: {
    label: "PNG image",
    extension: ".png",
    mime: "image/png",
    // PNG signature (first 4 of 8 bytes — enough to tell it apart from everything else here)
    magic: [0x89, 0x50, 0x4e, 0x47],
  },
};

export const SUPPORTED_EXTENSIONS = Object.values(KINDS).map((k) => k.extension);

const IMAGE_KINDS = new Set(["jpg", "jpeg", "png"]);
/** A standalone image upload (as opposed to a PDF or Word FILE that may itself contain images). */
export const isImageKind = (kind) => IMAGE_KINDS.has(kind);

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
    : "Only PDF, Word (.docx), JPEG (.jpg/.jpeg) or PNG files can be uploaded.";
