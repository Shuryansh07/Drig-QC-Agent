import { pool } from "./pool.js";

// Phase 1 has exactly one organization and one workflow (seeded by
// db/migrations/20260921000600_seed.sql — see DATABASE.md INV-8). Every
// caller that needs org_id/workflow_id resolves it through here instead of
// hardcoding a literal, so the single-tenant assumption lives in one place.
const ORG_NAME = "DRIG USA";
const WORKFLOW_CODE = "qc_support";

let cached: { orgId: string; workflowId: string } | null = null;

export const getDefaultOrg = async (): Promise<{ orgId: string; workflowId: string }> => {
  if (cached) return cached;

  const { rows } = await pool.query<{ org_id: string; workflow_id: string }>(
    `select o.org_id, w.workflow_id
       from organization o
       join workflow w on w.org_id = o.org_id and w.code = $2
      where o.name = $1`,
    [ORG_NAME, WORKFLOW_CODE]
  );

  const row = rows[0];
  if (!row) {
    throw new Error(`Seed data missing: no organization "${ORG_NAME}" with workflow "${WORKFLOW_CODE}"`);
  }

  cached = { orgId: row.org_id, workflowId: row.workflow_id };
  return cached;
};

// kb_document.source_id is required (references kb_source). Ad-hoc uploads
// (as opposed to a scheduled WorkDrive/Sheet sync) all land under one
// kb_source row of type 'upload', created lazily on first use.
let uploadSourceId: string | null = null;

export const getUploadSourceId = async (): Promise<string> => {
  if (uploadSourceId) return uploadSourceId;

  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query<{ source_id: string }>(
    `insert into kb_source (org_id, type, name, config_json)
     values ($1, 'upload', 'Manual Uploads', '{}')
     on conflict (org_id, name) do update set name = excluded.name
     returning source_id`,
    [orgId]
  );

  uploadSourceId = rows[0].source_id;
  return uploadSourceId;
};
