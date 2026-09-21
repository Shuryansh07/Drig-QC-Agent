import { pool } from "./pool.js";

/** The only code path that may set kb_chunk.is_live = true. Refuses if any chunk lacks an embedding. */
export const publishDocumentVersion = async (docId: string, version: number): Promise<void> => {
  await pool.query(`select publish_document_version($1, $2)`, [docId, version]);
};

/** Takes a document out of the search index (supersede/archive) while keeping it for citations (INV-7). */
export const retireDocument = async (
  docId: string,
  status: "superseded" | "archived",
  supersededBy: string | null = null
): Promise<void> => {
  await pool.query(`select retire_document($1, $2, $3)`, [docId, status, supersededBy]);
};

export interface WiringValidationResult {
  rule: string;
  affected: number;
}

/** Runs V1/V2/V4/V5 against a wiring sheet version. Run before publish_wiring_version. */
export const runWiringValidation = async (
  orgId: string,
  sheetVersion: number
): Promise<WiringValidationResult[]> => {
  const { rows } = await pool.query(`select * from run_wiring_validation($1, $2)`, [orgId, sheetVersion]);
  return rows.map((r) => ({ rule: r.rule, affected: r.affected }));
};

/** Atomic swap to a new wiring sheet version. Old versions are soft-deleted. */
export const publishWiringVersion = async (orgId: string, sheetVersion: number): Promise<void> => {
  await pool.query(`select publish_wiring_version($1, $2)`, [orgId, sheetVersion]);
};
