-- ============================================================================
-- 0600  Seed                                         PORTABLE: Supabase + RDS
-- ============================================================================
-- Reference data every environment needs, production included. That is why
-- this is a migration and not supabase/seed.sql, which only runs on local
-- `supabase db reset`. Every insert is idempotent.
-- ============================================================================

insert into organization (name) values ('DRIG USA')
  on conflict (name) do nothing;

insert into workflow (org_id, code, name)
select org_id, 'qc_support', 'QC Support' from organization where name = 'DRIG USA'
  on conflict (org_id, code) do nothing;

insert into app_role (org_id, code, name)
select o.org_id, r.code, r.name
from organization o
cross join (values
  ('technician', 'Field Technician'),
  ('engineer',   'In-office Engineer'),
  ('manager',    'Manager'),
  ('admin',      'Administrator')
) as r(code, name)
where o.name = 'DRIG USA'
  on conflict (org_id, code) do nothing;

insert into permission (code, description) values
  ('chat.ask',              'Ask the assistant questions'),
  ('handoff.receive',       'Receive escalated conversations'),
  ('conversation.view_all', 'See every conversation, not only your own'),
  ('knowledge.upload',      'Upload documents'),
  ('knowledge.review',      'Approve, edit or reject call cards and flagged data'),
  ('knowledge.publish',     'Publish documents and card batches'),
  ('knowledge.retire',      'Supersede or archive documents'),
  ('dashboard.view',        'See dashboards and the gap report'),
  ('settings.edit',         'Change thresholds, prompts and allowlists'),
  ('users.manage',          'Add people and assign roles')
  on conflict (code) do nothing;

-- Permissions are checked in code. Roles are data. Adding a role is a row.
insert into app_role_permission (role_id, permission_id)
select r.role_id, p.permission_id
from app_role r
join organization o on o.org_id = r.org_id and o.name = 'DRIG USA'
join (values
  ('technician', 'chat.ask'),
  ('engineer',   'chat.ask'), ('engineer', 'handoff.receive'), ('engineer', 'knowledge.review'),
  ('manager',    'chat.ask'), ('manager', 'conversation.view_all'), ('manager', 'knowledge.upload'),
  ('manager',    'knowledge.review'), ('manager', 'knowledge.publish'), ('manager', 'knowledge.retire'),
  ('manager',    'dashboard.view'),
  ('admin',      'chat.ask'), ('admin', 'conversation.view_all'), ('admin', 'knowledge.upload'),
  ('admin',      'knowledge.review'), ('admin', 'knowledge.publish'), ('admin', 'knowledge.retire'),
  ('admin',      'dashboard.view'), ('admin', 'settings.edit'), ('admin', 'users.manage')
) as m(role_code, perm_code) on m.role_code = r.code
join permission p on p.code = m.perm_code
  on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Tunables (INV-4). Starting values; tune them on the golden set, not by feel.
--
-- Regex escaping: a SQL literal holding JSON holding a regex. `\\b` in the
-- literal stores the single backslash the regex needs. `\\\\b` would store a
-- literal backslash and the pattern would silently match nothing.
-- Two dialects of the same Gate 6 patterns:
--   gate.literal_patterns     application side (JS / Python / PCRE): \b
--   gate.literal_patterns_pg  inside Postgres (POSIX): \y  -- \b is BACKSPACE there
-- ---------------------------------------------------------------------------
insert into setting (org_id, workflow_id, key, value_json, description)
select o.org_id, w.workflow_id, s.key, s.val::jsonb, s.descr
from organization o
join workflow w on w.org_id = o.org_id and w.code = 'qc_support'
cross join (values
  ('retrieval.admit_min_similarity', '0.35',
   'Gate 2. Best dense_similarity below this means no generation. Tune on the golden set: raise to refuse more, lower to answer more. Watch the false-refusal rate as closely as the hallucination rate.'),
  ('retrieval.admit_on_exact_code', 'true',
   'Gate 2. Admit anyway when the lexical arm matched an exact part or model code from the question.'),
  ('retrieval.match_count',   '8',     'Chunks passed to the generator.'),
  ('retrieval.candidate_k',   '20',    'Candidates per search arm before fusion.'),
  ('retrieval.rrf_k',         '60',    'Reciprocal Rank Fusion constant.'),
  ('retrieval.boost_vendor',  '0.003', 'Soft boost for a vendor match. RRF top score per arm is about 0.016, so keep boosts small.'),
  ('retrieval.boost_model',   '0.002', 'Soft boost for a model match.'),
  ('retrieval.boost_language','0.001', 'Soft boost for the technician''s language.'),
  ('gate.frame_model',    '"gpt-5.6-luna"',  'Small fast model for frame extraction. Use a dated snapshot id when the provider offers one, never a floating alias.'),
  ('gate.coverage_model', '"gpt-5.6-luna"',  'Small fast model for the coverage gate.'),
  ('gate.answer_model',   '"gpt-5.6-terra"', 'Generation model. Changing it is a deliberate change that reruns the golden set.'),
  ('gate.embedding_model','"text-embedding-3-small"',  'Must match the vector(1536) columns. Changing it means re-embedding everything.'),
  ('gate.literal_patterns',
   '["[A-Z0-9]{2,}-[A-Z0-9]{2,}", "\\b\\d+\\s?(V|A|Nm|ft-lb|mm|AWG|ohm)\\b", "\\bpin\\s?\\d+\\b"]',
   'Gate 6, APPLICATION side (PCRE / JS / Python).'),
  ('gate.literal_patterns_pg',
   '["[A-Z0-9]{2,}-[A-Z0-9]{2,}", "\\y(\\d+\\s?(?:V|A|Nm|ft-lb|mm|AWG|ohm))\\y", "\\y(pin\\s?\\d+)\\y"]',
   'Gate 6 patterns for use INSIDE Postgres (POSIX). Word boundary is \y.'),
  ('gate.safety_lexicon',
   '["disconnect", "isolate", "de-energize", "de-energise", "warning", "caution", "before you", "do not"]',
   'Gate 7. A cited source sentence containing any of these must survive into the answer.'),
  ('gate.deadline_ms', '22000', 'Hard internal deadline. On breach, send what is validated plus a handoff offer.'),
  ('slots.required',
   '{"wiring_lookup": ["make", "model", "year", "circuit"], "troubleshoot": ["symptom"], "info": ["product"], "procedure": ["product"]}',
   'Gate 1. Required slots per intent. Missing slots are only asked about when the answer depends on them.'),
  ('web.allowlist', '[]', 'Domains the web fallback may fetch. Empty disables the fallback. Review monthly.'),
  ('limits.queries_per_tech_per_day', '80', 'Per-technician rate limit.'),
  ('voice.confirm_below_confidence', '0.75', 'Below this ASR confidence, confirm what was heard before searching.')
) as s(key, val, descr)
where o.name = 'DRIG USA'
  on conflict (org_id, workflow_id, key) do nothing;
