import { pool } from "./pool.js";
import { getDefaultOrg } from "./org.js";
import { toVectorLiteral } from "./vector.js";
import { stripNul } from "../utils/sanitize.js";

/**
 * The improvement loop (Blueprint scenario D): every refusal is recorded, so
 * management sees "nine technicians asked about X, nothing documented" and
 * knows what to write next. Rows are grouped later by query_vec similarity.
 *
 * No session yet: the backend has no chat sessions until auth exists, so
 * session_id stays null.
 */
export const recordGap = async ({
  queryText,
  queryEmbedding,
  retrievedIds,
  reason,
}: {
  queryText: string;
  queryEmbedding: number[];
  retrievedIds: string[];
  reason: "not_covered" | "conflict" | "quarantined";
}): Promise<void> => {
  const { orgId, workflowId } = await getDefaultOrg();
  await pool.query(
    `insert into kb_gap (org_id, workflow_id, query_text, query_vec, retrieved_ids, reason)
     values ($1, $2, $3, $4::extensions.vector, $5::uuid[], $6)`,
    [orgId, workflowId, stripNul(queryText).slice(0, 2000), toVectorLiteral(queryEmbedding), retrievedIds, reason]
  );
};
