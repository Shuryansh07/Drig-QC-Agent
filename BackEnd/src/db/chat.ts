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

/**
 * A question the assistant did not answer:
 *   not_found    — refused: nothing in the knowledge base matched (gate_outcome not_covered)
 *   no_answer    — passages were found but the model saw no answer in them (turn_json.noAnswer)
 *   not_resolved — answered, but the technician marked it "not resolved"
 *   no_reply     — the question has no reply saved: the answer failed, or was cancelled
 */
export type MissKind = "not_found" | "no_answer" | "not_resolved" | "no_reply";

export interface UnansweredQuestion {
  turnId: string;
  sessionId: string;
  kind: MissKind;
  /** The question as searched: follow-ups rewritten to stand alone, when recorded. */
  question: string;
  /** What the technician actually typed (or picked, after a clarification). */
  asked: string;
  /** The assistant's reply; null for no_reply. */
  reply: string | null;
  createdAt: Date;
}

/** A question still waiting this long with no reply saved is treated as one that failed, not one in progress. */
const NO_REPLY_AFTER = "2 minutes";

const MISSES_SQL = `
  with ordered as (
    select t.turn_id, t.session_id, t.role, t.text, t.gate_outcome, t.turn_json, t.resolution, t.created_at,
           lag(t.text) over w as prev_text,
           lead(t.role) over w as next_role
      from chat_turn t
      join chat_conversation c on c.session_id = t.session_id
     where c.org_id = $1
    window w as (partition by t.session_id order by t.seq)
  ),
  misses as (
    select turn_id, session_id, created_at,
           case
             when role = 'technician' then 'no_reply'
             when gate_outcome = 'not_covered' then 'not_found'
             when coalesce((turn_json->>'noAnswer')::boolean, false) then 'no_answer'
             else 'not_resolved'
           end as kind,
           case when role = 'technician' then text else coalesce(nullif(turn_json->>'standalone_question', ''), prev_text, '') end as question,
           case when role = 'technician' then text else coalesce(prev_text, '') end as asked,
           case when role = 'agent' then text end as reply,
           -- An admin wrote an answer for it (answerUnanswered), and that FAQ entry is still active.
           exists (select 1 from faq_entry f where f.faq_id::text = turn_json->>'adminFaqId' and f.active) as answered
      from ordered
     where (role = 'agent'
            and (gate_outcome = 'not_covered' or coalesce((turn_json->>'noAnswer')::boolean, false) or resolution = 'not_resolved'))
        or (role = 'technician'
            and (next_role is null or next_role = 'technician')
            and created_at < now() - interval '${NO_REPLY_AFTER}')
  )`;

/** Unanswered questions, newest first, with a count per kind (before the kind filter, after the search). */
export const listUnanswered = async ({
  kind,
  search,
  limit,
  offset,
}: {
  kind?: MissKind | null;
  search?: string | null;
  limit: number;
  offset: number;
}): Promise<{ items: UnansweredQuestion[]; total: number; counts: Record<MissKind, number> }> => {
  const { orgId } = await getDefaultOrg();
  const pattern = search ? `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const [list, counts] = await Promise.all([
    pool.query(
      `${MISSES_SQL}
       select *
         from misses
        where not answered
          and ($2::text is null or kind = $2)
          and ($3::text is null or question ilike $3 or asked ilike $3)
        order by created_at desc
        limit $4 offset $5`,
      [orgId, kind ?? null, pattern, limit, offset]
    ),
    pool.query(
      `${MISSES_SQL}
       select kind, count(*)::int as n
         from misses
        where not answered
          and ($2::text is null or question ilike $2 or asked ilike $2)
        group by kind`,
      [orgId, pattern]
    ),
  ]);
  const byKind: Record<MissKind, number> = { not_found: 0, no_answer: 0, not_resolved: 0, no_reply: 0 };
  for (const r of counts.rows) byKind[r.kind as MissKind] = r.n;
  return {
    items: list.rows.map((r) => ({
      turnId: r.turn_id,
      sessionId: r.session_id,
      kind: r.kind,
      question: r.question,
      asked: r.asked,
      reply: r.reply,
      createdAt: r.created_at,
    })),
    // From the counts, not the page: a page past the end still knows how many there are.
    total: kind ? byKind[kind] : Object.values(byKind).reduce((a, b) => a + b, 0),
    counts: byKind,
  };
};

/** Notes on a turn that an admin answered it with this FAQ entry, so it leaves the unanswered list. */
export const markTurnAnswered = async (turnId: string, faqId: string): Promise<boolean> => {
  const { rowCount } = await pool.query(
    `update chat_turn set turn_json = turn_json || jsonb_build_object('adminFaqId', $2::text) where turn_id = $1`,
    [turnId, faqId]
  );
  return (rowCount ?? 0) > 0;
};

/** Sets how the technician rated an agent turn. Returns the turn, or null when it does not exist in that session. */
export const setResolution = async (sessionId: string, turnId: string, resolution: Resolution): Promise<SavedTurn | null> => {
  const { rows } = await pool.query(
    `update chat_turn set resolution = $3 where session_id = $1 and turn_id = $2 and role = 'agent' returning *`,
    [sessionId, turnId, resolution]
  );
  return rows[0] ? mapTurn(rows[0]) : null;
};
