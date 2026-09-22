import { pool } from "./pool.js";
import { getDefaultOrg } from "./org.js";
import { stripNul } from "../utils/sanitize.js";

// Vision descriptions of diagrams, photos, charts and tables
// (db/migrations/20260921000740_visual_descriptions.sql). One kb_image row per
// described page or image. The picture itself is not stored yet (no object
// storage adapter), so s3_key is null; the description is MODEL-GENERATED and
// is_citable stays false (Blueprint section 7).

export type VisualType = "diagram" | "photo" | "table" | "chart" | "screenshot" | "mixed" | "decorative" | "none";

export interface FigureRecord {
  /** PDF page number; null for a Word image, which has no page. */
  page: number | null;
  contentHash: string;
  sourceKind: "pdf_page" | "docx_image";
  visualType: VisualType;
  /** Empty for decorative / nothing-to-describe results, which are cached so they are not asked again. */
  description: string;
  modelTag: string;
}

// kb_image.image_type is a closed set; the vision model's vocabulary is wider.
const IMAGE_TYPE: Record<VisualType, string> = {
  diagram: "diagram",
  chart: "diagram",
  mixed: "diagram",
  photo: "photo",
  screenshot: "screenshot",
  table: "table_scan",
  decorative: "decorative",
  none: "decorative",
};

// ...and the reverse, for a cache hit.
const VISUAL_TYPE: Record<string, VisualType> = {
  diagram: "diagram",
  photo: "photo",
  screenshot: "screenshot",
  table_scan: "table",
  decorative: "decorative",
};

/**
 * Descriptions already produced for this document's images, across every
 * version. Vision is slow and costs money per call, so a retry (or a re-ingest of
 * unchanged content) must not pay for the same picture twice. A different model
 * or prompt version is a different tag, so it correctly misses.
 */
export const loadFigureCache = async (
  docId: string,
  modelTag: string
): Promise<Map<string, { visualType: VisualType; description: string }>> => {
  const { rows } = await pool.query<{ content_hash: string; image_type: string; description: string | null }>(
    `select distinct on (content_hash) content_hash, image_type, description
       from kb_image
      where doc_id = $1 and content_hash is not null and description_model = $2
      order by content_hash, version desc`,
    [docId, modelTag]
  );
  return new Map(
    rows.map((r) => [r.content_hash, { visualType: VISUAL_TYPE[r.image_type] ?? "mixed", description: r.description ?? "" }])
  );
};

/**
 * Not live until publish_document_version() flips the whole version at once.
 *
 * Idempotent: called once per description as it arrives (so a crash or a retry
 * never loses paid work) and again with the full set at the end. A picture already
 * stored for this version is skipped, and unpublished rows from an interrupted
 * earlier attempt are deliberately KEPT: they are exactly the cache a retry reads.
 */
export const insertFigures = async (docId: string, version: number, figures: FigureRecord[]): Promise<void> => {
  // Two pages can render identically; the unique index would reject the second within one statement.
  const unique = [...new Map(figures.map((f) => [f.contentHash, f])).values()];
  if (unique.length === 0) return;
  figures = unique;
  const { orgId } = await getDefaultOrg();

  await pool.query(
    `insert into kb_image
       (org_id, doc_id, version, page, image_type, description, description_model, content_hash, source_kind, is_citable)
     select $1, $2, $3, t.page, t.image_type, nullif(t.description, ''), t.model, t.hash, t.kind, false
       from unnest($4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
            as t(page, image_type, description, model, hash, kind)
     on conflict (doc_id, version, content_hash) where content_hash is not null do nothing`,
    [
      orgId,
      docId,
      version,
      figures.map((f) => f.page),
      figures.map((f) => IMAGE_TYPE[f.visualType] ?? "diagram"),
      figures.map((f) => stripNul(f.description)),
      figures.map((f) => f.modelTag),
      figures.map((f) => f.contentHash),
      figures.map((f) => f.sourceKind),
    ]
  );
};

/** How many figures of a document were described (live version). */
export const countFigures = async (docId: string): Promise<number> => {
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count from kb_image
      where doc_id = $1 and deleted_at is null and description is not null and image_type <> 'decorative'`,
    [docId]
  );
  return parseInt(rows[0].count, 10);
};
