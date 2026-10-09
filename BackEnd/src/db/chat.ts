import { pool } from "./pool.js";
import { getDefaultOrg } from "./org.js";

// Chat history (migration 0800). The server writes every turn as it happens;
// the browser only reads it back, so a reload or another device sees the same chat.

export type TurnRole = "technician" | "agent";
export type Resolution = "resolved" | "partly" | "not_resolved";

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export interface SavedTurn {
  turnId: string;
  sessionId: string;
  role: TurnRole;
  text: string;
  gateOutcome: string | null;
  turnJson: Record<string, any>;
  resolution: Resolution | null;
  createdAt: Date;
}

const mapTurn = (r: any): SavedTurn => ({
  turnId: r.turn_id,
  sessionId: r.session_id,
  role: r.role,
  text: r.text,
  gateOutcome: r.gate_outcome,
  turnJson: r.turn_json ?? {},
  resolution: r.resolution,
  createdAt: r.created_at,
});

/** Saves a turn, creating the conversation on first use. Idempotent on turnId. */
export const saveTurn = async (turn: {
  sessionId: string;
  turnId: string;
  role: TurnRole;
  text: string;
  gateOutcome?: string | null;
  turnJson?: Record<string, unknown>;
}): Promise<void> => {
  const { orgId } = await getDefaultOrg();
  await pool.query(
    `insert into chat_conversation (session_id, org_id) values ($1, $2)
       on conflict (session_id) do update set updated_at = now()`,
    [turn.sessionId, orgId]
  );
  await pool.query(
    `insert into chat_turn (turn_id, session_id, role, text, gate_outcome, turn_json)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (turn_id) do update
        set text = excluded.text, gate_outcome = excluded.gate_outcome, turn_json = excluded.turn_json`,
    [turn.turnId, turn.sessionId, turn.role, turn.text, turn.gateOutcome ?? null, JSON.stringify(turn.turnJson ?? {})]
  );
};

export const getConversation = async (sessionId: string): Promise<SavedTurn[]> =>
  (await pool.query(`select * from chat_turn where session_id = $1 order by seq`, [sessionId])).rows.map(mapTurn);

/** Sets how the technician rated an agent turn. Returns the turn, or null when it does not exist in that session. */
export const setResolution = async (sessionId: string, turnId: string, resolution: Resolution): Promise<SavedTurn | null> => {
  const { rows } = await pool.query(
    `update chat_turn set resolution = $3 where session_id = $1 and turn_id = $2 and role = 'agent' returning *`,
    [sessionId, turnId, resolution]
  );
  return rows[0] ? mapTurn(rows[0]) : null;
};
