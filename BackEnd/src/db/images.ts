import { pool } from "./pool.js";
import { getDefaultOrg } from "./org.js";
import { stripNul } from "../utils/sanitize.js";

// Vision descriptions of diagrams, photos, charts and tables
// (db/migrations/20260921000740_visual_descriptions.sql). One kb_image row per
// described page or image. The picture itself is stored in S3 (s3_key) so the
// answer model can look at it; s3_key is null for rows written before that, and
// for decorative pictures. The description is MODEL-GENERATED and is_citable
// stays false (Blueprint section 7).

export type VisualType = "diagram" | "photo" | "table" | "chart" | "screenshot" | "mixed" | "decorative" | "none";

export interface FigureRecord {
  /** PDF page number; null for a Word image, which has no page. Always 1 for a standalone image upload. */
  page: number | null;
  contentHash: string;
  sourceKind: "pdf_page" | "docx_image" | "image_upload";
  visualType: VisualType;
  /** Empty for decorative / nothing-to-describe results, which are cached so they are not asked again. */
  description: string;
  modelTag: string;
  /** Where the picture itself is stored; null when it is decorative or could not be stored. */
  s3Key?: string | null;
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
       (org_id, doc_id, version, page, image_type, description, description_model, content_hash, source_kind, is_citable, s3_key)
     select $1, $2, $3, t.page, t.image_type, nullif(t.description, ''), t.model, t.hash, t.kind, false, t.s3_key
       from unnest($4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
            as t(page, image_type, description, model, hash, kind, s3_key)
     on conflict (doc_id, version, content_hash) where content_hash is not null
     do update set s3_key = coalesce(kb_image.s3_key, excluded.s3_key)`,
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
      figures.map((f) => f.s3Key ?? null),
    ]
  );
};

export interface FigureImageRef {
  docId: string;
  /** A PDF page or standalone image (page 1); every live picture on it matches. */
  page?: number | null;
  /** A specific picture (a Word image has no page, so it is found by hash). */
  contentHash?: string | null;
}

export interface FigureImage {
  docId: string;
  page: number | null;
  contentHash: string;
  s3Key: string;
  visualType: string;
}

/**
 * The stored pictures behind retrieved evidence: live, described (not decorative)
 * and actually stored. Returned in the order of `refs`, so the caller's best-ranked
 * evidence comes first.
 */
export const findFigureImages = async (refs: FigureImageRef[]): Promise<FigureImage[]> => {
  if (refs.length === 0) return [];
  const { rows } = await pool.query<{ ord: number; doc_id: string; page: number | null; content_hash: string; s3_key: string; image_type: string }>(
    `select r.ord, i.doc_id, i.page, i.content_hash, i.s3_key, i.image_type
       from unnest($1::uuid[], $2::int[], $3::text[]) with ordinality as r(doc_id, page, hash, ord)
       join kb_image i on i.doc_id = r.doc_id
                      and (i.content_hash = r.hash or (r.hash is null and i.page = r.page))
      where i.is_live and i.deleted_at is null and i.s3_key is not null
        and i.description is not null and i.image_type <> 'decorative'
      order by r.ord, i.page nulls last`,
    [refs.map((r) => r.docId), refs.map((r) => r.page ?? null), refs.map((r) => r.contentHash ?? null)]
  );

  const seen = new Set<string>();
  return rows
    .filter((r) => !seen.has(r.s3_key) && seen.add(r.s3_key))
    .map((r) => ({ docId: r.doc_id, page: r.page, contentHash: r.content_hash, s3Key: r.s3_key, visualType: r.image_type }));
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
