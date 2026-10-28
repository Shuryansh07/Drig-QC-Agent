import { pool } from "./pool.js";
import { getDefaultOrg } from "./org.js";

// The DRIG vehicle wiring guide (migration 0840): imports, the link cache,
// stored photos/guides and the vehicle rows. Written by the import job
// (services/wiring/drigWiringImport.service.js), read by the chat's wiring
// lookup (services/wiring/wiringLookup.service.js) and the admin panel.

export type ImportStatus = "queued" | "processing" | "completed" | "completed_with_errors" | "failed";

export interface WiringImport {
  importId: string;
  fileName: string;
  contentHash: string;
  s3Key: string;
  status: ImportStatus;
  stage: string | null;
  counts: Record<string, number>;
  error: string | null;
  isLive: boolean;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

const mapImport = (r: any): WiringImport => ({
  importId: r.import_id,
  fileName: r.file_name,
  contentHash: r.content_hash,
  s3Key: r.s3_key,
  status: r.status,
  stage: r.stage,
  counts: r.counts ?? {},
  error: r.error,
  isLive: r.is_live,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export const createImport = async ({ fileName, contentHash, s3Key }: { fileName: string; contentHash: string; s3Key: string }): Promise<WiringImport> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query(
    `insert into drig_wiring_import (org_id, file_name, content_hash, s3_key) values ($1, $2, $3, $4) returning *`,
    [orgId, fileName, contentHash, s3Key]
  );
  return mapImport(rows[0]);
};

export const getImport = async (importId: string): Promise<WiringImport | null> => {
  const { rows } = await pool.query(`select * from drig_wiring_import where import_id = $1`, [importId]);
  return rows[0] ? mapImport(rows[0]) : null;
};

/** An import of the same bytes that is live, or still being built. Uploading the same workbook twice is a no-op. */
export const findActiveImportByHash = async (contentHash: string): Promise<WiringImport | null> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query(
    `select * from drig_wiring_import
      where org_id = $1 and content_hash = $2 and (is_live or status in ('queued','processing'))
      order by created_at desc limit 1`,
    [orgId, contentHash]
  );
  return rows[0] ? mapImport(rows[0]) : null;
};

export const listImports = async (limit = 10): Promise<WiringImport[]> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query(`select * from drig_wiring_import where org_id = $1 order by created_at desc limit $2`, [orgId, limit]);
  return rows.map(mapImport);
};

export const updateImport = async (
  importId: string,
  fields: Partial<{ status: ImportStatus; stage: string | null; counts: Record<string, number>; error: string | null; started: boolean; finished: boolean }>
): Promise<void> => {
  const sets: string[] = [];
  const values: unknown[] = [importId];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    sets.push(`${sql} = $${values.length}`);
  };
  if (fields.status !== undefined) add("status", fields.status);
  if ("stage" in fields) add("stage", fields.stage);
  if (fields.counts !== undefined) add("counts", JSON.stringify(fields.counts));
  if ("error" in fields) add("error", fields.error);
  if (fields.started) sets.push("started_at = coalesce(started_at, now())");
  if (fields.finished) sets.push("finished_at = now()");
  if (sets.length === 0) return;
  await pool.query(`update drig_wiring_import set ${sets.join(", ")} where import_id = $1`, values);
};

/**
 * Makes `importId` the live guide, in one transaction: the chat switches from
 * the old guide to the new one with no moment where neither (or both) is live.
 */
export const publishImport = async (importId: string): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(`select org_id from drig_wiring_import where import_id = $1 for update`, [importId]);
    if (!rows[0]) throw new Error(`Wiring import ${importId} not found`);
    await client.query(`update drig_wiring_import set is_live = false where org_id = $1 and is_live and import_id <> $2`, [rows[0].org_id, importId]);
    await client.query(`update drig_wiring_import set is_live = true where import_id = $1`, [importId]);
    await client.query(`insert into event_log (org_id, event_type, payload) values ($1, 'drig_wiring.published', $2::jsonb)`, [
      rows[0].org_id,
      JSON.stringify({ import_id: importId }),
    ]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// Links and stored files
// ---------------------------------------------------------------------------

export type LinkStatus = "stored" | "requires_login" | "icon" | "unsupported" | "failed";

export interface LinkRecord {
  sourceUrl: string;
  linkKind: string;
  status: LinkStatus;
  assetId: string | null;
  error: string | null;
  attempts: number;
}

export const loadLinks = async (): Promise<Map<string, LinkRecord>> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query(`select * from drig_wiring_link where org_id = $1`, [orgId]);
  return new Map(
    rows.map((r) => [
      r.source_url,
      { sourceUrl: r.source_url, linkKind: r.link_kind, status: r.status, assetId: r.asset_id, error: r.error, attempts: r.attempts },
    ])
  );
};

export const saveLink = async ({ sourceUrl, linkKind, status, assetId, error }: Omit<LinkRecord, "attempts">): Promise<void> => {
  const { orgId } = await getDefaultOrg();
  await pool.query(
    `insert into drig_wiring_link (org_id, source_url, link_kind, status, asset_id, error)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (org_id, source_url) do update
       set link_kind = excluded.link_kind, status = excluded.status, asset_id = excluded.asset_id,
           error = excluded.error, attempts = drig_wiring_link.attempts + 1, fetched_at = now()`,
    [orgId, sourceUrl, linkKind, status, assetId, error]
  );
};

export interface AssetRecord {
  assetId: string;
  contentHash: string;
  kind: "image" | "pdf";
  mimeType: string;
  s3Key: string;
  previewKey: string | null;
  thumbKey: string | null;
  width: number | null;
  height: number | null;
  pageCount: number | null;
  textLayer: string | null;
  ocrStatus: "pending" | "done" | "no_text" | "failed" | "skipped";
  ocrText: string | null;
  ocrJson: any;
}

const mapAsset = (r: any): AssetRecord => ({
  assetId: r.asset_id,
  contentHash: r.content_hash,
  kind: r.kind,
  mimeType: r.mime_type,
  s3Key: r.s3_key,
  previewKey: r.preview_key,
  thumbKey: r.thumb_key,
  width: r.width,
  height: r.height,
  pageCount: r.page_count,
  textLayer: r.text_layer,
  ocrStatus: r.ocr_status,
  ocrText: r.ocr_text,
  ocrJson: r.ocr_json,
});

export const findAssetByHash = async (contentHash: string): Promise<AssetRecord | null> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query(`select * from drig_wiring_asset where org_id = $1 and content_hash = $2`, [orgId, contentHash]);
  return rows[0] ? mapAsset(rows[0]) : null;
};

/** Idempotent on the content hash: two links to identical bytes share one asset. */
export const insertAsset = async (a: {
  contentHash: string;
  kind: "image" | "pdf";
  mimeType: string;
  s3Key: string;
  previewKey: string | null;
  thumbKey: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
  pageCount: number | null;
  textLayer: string | null;
  ocrStatus: "pending" | "skipped";
}): Promise<AssetRecord> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query(
    `insert into drig_wiring_asset
       (org_id, content_hash, kind, mime_type, s3_key, preview_key, thumb_key, width, height, bytes, page_count, text_layer, ocr_status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (org_id, content_hash) do update set content_hash = excluded.content_hash
     returning *`,
    [orgId, a.contentHash, a.kind, a.mimeType, a.s3Key, a.previewKey, a.thumbKey, a.width, a.height, a.bytes, a.pageCount, a.textLayer, a.ocrStatus]
  );
  return mapAsset(rows[0]);
};

/** Assets still to be read (or whose last reading failed), among those this import links to. */
export const listAssetsToOcr = async (assetIds: string[]): Promise<AssetRecord[]> => {
  if (assetIds.length === 0) return [];
  const { rows } = await pool.query(
    `select * from drig_wiring_asset where asset_id = any($1::uuid[]) and ocr_status in ('pending','failed') and preview_key is not null`,
    [assetIds]
  );
  return rows.map(mapAsset);
};

export const saveOcr = async (
  assetId: string,
  r: { status: "done" | "no_text" | "failed"; text?: string | null; json?: unknown; model: string; error?: string | null }
): Promise<void> => {
  await pool.query(
    `update drig_wiring_asset
        set ocr_status = $2, ocr_text = $3, ocr_json = $4, ocr_model = $5, ocr_error = $6, ocr_at = now()
      where asset_id = $1`,
    [assetId, r.status, r.text ?? null, r.json ? JSON.stringify(r.json) : null, r.model, r.error ?? null]
  );
};

// ---------------------------------------------------------------------------
// Vehicle rows
// ---------------------------------------------------------------------------

export interface SheetEntry {
  circuit: "12v" | "ignition";
  cellKind: "text" | "link" | "icon" | "empty";
  cellText: string | null;
  linkUrl: string | null;
}

export interface SheetVehicle {
  sourceRow: number;
  year: number;
  makeRaw: string;
  makeKeys: string[];
  modelRaw: string;
  model: string;
  modelKey: string;
  startType: "pts" | "key" | null;
  requiresLogin: boolean;
  needsDownload: boolean;
  entries: SheetEntry[];
}

/**
 * Replaces the import's vehicle rows with `vehicles` (a resumed job starts the
 * rows over; the downloads and readings it already did are kept elsewhere).
 * One transaction, in batches of unnest() inserts.
 */
export const replaceImportVehicles = async (importId: string, vehicles: SheetVehicle[]): Promise<void> => {
  const { orgId } = await getDefaultOrg();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from drig_wiring_vehicle where import_id = $1`, [importId]);

    const BATCH = 500;
    for (let i = 0; i < vehicles.length; i += BATCH) {
      const batch = vehicles.slice(i, i + BATCH);
      const { rows } = await client.query(
        `insert into drig_wiring_vehicle
           (org_id, import_id, source_row, year, make_raw, make_keys, model_raw, model, model_key, start_type, requires_login, needs_download)
         select $1, $2, t.source_row, t.year, t.make_raw, string_to_array(t.make_keys, '|'), t.model_raw, t.model, t.model_key,
                t.start_type, t.requires_login, t.needs_download
           from unnest($3::int[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::boolean[], $12::boolean[])
                as t(source_row, year, make_raw, make_keys, model_raw, model, model_key, start_type, requires_login, needs_download)
         returning vehicle_id, source_row`,
        [
          orgId,
          importId,
          batch.map((v) => v.sourceRow),
          batch.map((v) => v.year),
          batch.map((v) => v.makeRaw),
          batch.map((v) => v.makeKeys.join("|")),
          batch.map((v) => v.modelRaw),
          batch.map((v) => v.model),
          batch.map((v) => v.modelKey),
          batch.map((v) => v.startType),
          batch.map((v) => v.requiresLogin),
          batch.map((v) => v.needsDownload),
        ]
      );
      const idByRow = new Map(rows.map((r) => [r.source_row, r.vehicle_id]));
      const entries = batch.flatMap((v) => v.entries.map((e) => ({ ...e, vehicleId: idByRow.get(v.sourceRow) })));
      await client.query(
        `insert into drig_wiring_entry (vehicle_id, circuit, cell_kind, cell_text, link_url)
         select * from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])`,
        [entries.map((e) => e.vehicleId), entries.map((e) => e.circuit), entries.map((e) => e.cellKind), entries.map((e) => e.cellText), entries.map((e) => e.linkUrl)]
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
};

/**
 * SQL: does model column `col` answer to any key in parameter `$n`? Compared
 * without case or punctuation, as the whole name, the name without a bracketed
 * note ("ProMaster (Gas)"), or any one part of a combined name ("1500/2500/3500"
 * answers to "1500"). Parts shorter than 3 characters never match alone ("C/V").
 */
// POSIX classes, not backslash escapes: a backslash in this template literal would be eaten by JavaScript.
const WITHOUT_NOTE = (col: string) => `regexp_replace(lower(${col}), '[[:space:]]*[(][^)]*[)]', '', 'g')`;
export const modelMatchesSql = (col: string, param: string): string => `(
  regexp_replace(lower(${col}), '[^a-z0-9]+', '', 'g') = any(${param})
  or regexp_replace(${WITHOUT_NOTE(col)}, '[^a-z0-9]+', '', 'g') = any(${param})
  or exists (
    select 1 from unnest(string_to_array(${WITHOUT_NOTE(col)}, '/')) as part
     where length(regexp_replace(part, '[^a-z0-9]+', '', 'g')) >= 3
       and regexp_replace(part, '[^a-z0-9]+', '', 'g') = any(${param})))`;

// ---------------------------------------------------------------------------
// Chat lookup + vehicle picker
// ---------------------------------------------------------------------------

export interface DrigWiringHit {
  vehicleId: string;
  sourceRow: number;
  year: number;
  makeRaw: string;
  modelRaw: string;
  model: string;
  startType: "pts" | "key" | null;
  circuit: "12v" | "ignition";
  cellKind: "text" | "link" | "icon" | "empty";
  cellText: string | null;
  linkUrl: string | null;
  linkStatus: LinkStatus | null;
  linkError: string | null;
  asset: AssetRecord | null;
}

/**
 * Exact lookup in the LIVE guide: same year, a make key in common, the same
 * model key, and a start type that matches (a row not split by start type
 * matches either). Never a nearby year: zero rows is a valid answer.
 */
export const findDrigWiring = async ({
  makeKeys,
  modelKeys,
  year,
  startType,
}: {
  makeKeys: string[];
  modelKeys: string[];
  year: number;
  startType: "pts" | "key" | null;
}): Promise<DrigWiringHit[]> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query(
    `select v.vehicle_id, v.source_row, v.year, v.make_raw, v.model_raw, v.model, v.start_type,
            e.circuit, e.cell_kind, e.cell_text, e.link_url,
            l.status as link_status, l.error as link_error,
            a.*
       from drig_wiring_import i
       join drig_wiring_vehicle v on v.import_id = i.import_id
       join drig_wiring_entry e on e.vehicle_id = v.vehicle_id
       left join drig_wiring_link l on l.org_id = i.org_id and l.source_url = e.link_url
       left join drig_wiring_asset a on a.asset_id = l.asset_id and l.status = 'stored'
      where i.org_id = $1 and i.is_live
        and v.year = $2 and ${modelMatchesSql("v.model", "$3::text[]")} and v.make_keys && $4::text[]
        and ($5::text is null or v.start_type is null or v.start_type = $5)
      order by (v.start_type is null), v.source_row, e.circuit`,
    [orgId, year, modelKeys, makeKeys, startType]
  );
  return rows.map((r) => ({
    vehicleId: r.vehicle_id,
    sourceRow: r.source_row,
    year: r.year,
    makeRaw: r.make_raw,
    modelRaw: r.model_raw,
    model: r.model,
    startType: r.start_type,
    circuit: r.circuit,
    cellKind: r.cell_kind,
    cellText: r.cell_text,
    linkUrl: r.link_url,
    linkStatus: r.link_status,
    linkError: r.link_error,
    asset: r.asset_id ? mapAsset(r) : null,
  }));
};

/** Makes in the live guide (raw spellings), for the vehicle picker. */
export const listDrigMakes = async (): Promise<string[]> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query(
    `select distinct v.make_raw from drig_wiring_import i join drig_wiring_vehicle v on v.import_id = i.import_id
      where i.org_id = $1 and i.is_live order by 1`,
    [orgId]
  );
  return rows.map((r) => r.make_raw);
};

/** Base models (and their years) the live guide has for a make. */
export const listDrigModels = async (makeKeys: string[]): Promise<{ model: string; years: number[]; startTypes: string[] }[]> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query(
    `select v.model, array_agg(distinct v.year order by v.year) as years,
            array_remove(array_agg(distinct v.start_type), null) as start_types
       from drig_wiring_import i join drig_wiring_vehicle v on v.import_id = i.import_id
      where i.org_id = $1 and i.is_live and v.make_keys && $2::text[]
      group by v.model order by v.model`,
    [orgId, makeKeys]
  );
  return rows.map((r) => ({ model: r.model, years: r.years, startTypes: r.start_types }));
};
