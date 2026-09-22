/**
 * Postgres text and jsonb cannot hold a NUL (U+0000): the insert throws
 * `invalid byte sequence for encoding "UTF8": 0x00`. PDFs produce them (a symbol
 * font's bullet is extracted as NUL, see pdfStructure.js), and a model could too.
 * Everything written to the database goes through these, so one stray byte can
 * never fail a whole document, least of all after minutes of paid vision calls.
 */
export const stripNul = (text) => (typeof text === "string" ? text.replace(/\u0000/g, "") : text);

/** JSON.stringify for a jsonb parameter: NUL removed from every string inside it. */
export const safeJson = (value) => JSON.stringify(value, (_key, v) => (typeof v === "string" ? stripNul(v) : v));
