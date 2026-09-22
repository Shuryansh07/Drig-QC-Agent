-- ============================================================================
-- 0740  Visual descriptions                          PORTABLE: Supabase + RDS
-- ============================================================================
-- ADDITIVE. Pages and Word images that contain a diagram, photo, chart or table
-- are described by a vision model; the description is chunked and embedded like
-- any other text (kb_chunk rows with metadata.kind = 'figure').
--
-- kb_image (0200) was designed for exactly this record, with one difference we
-- have to relax: there is no object storage adapter yet, so the picture itself is
-- not stored and s3_key cannot be required. It becomes required again the day
-- images are saved and shown (Blueprint section 7).
--
--   content_hash  sha256 of the image bytes. Vision calls are slow and cost money;
--                 a retry or a re-ingest of an unchanged file reuses the stored
--                 description instead of asking the model again.
--   source_kind   'pdf_page' (a rendered page screenshot) | 'docx_image'
--
-- description stays MODEL-GENERATED and is_citable stays false: it is never
-- treated as the manual's own words (see the answer prompt).
-- ============================================================================

alter table kb_image alter column s3_key drop not null;
alter table kb_image add column if not exists content_hash text;
alter table kb_image add column if not exists source_kind  text;

create index if not exists kb_image_doc_hash on kb_image (doc_id, content_hash);

-- ---------------------------------------------------------------------------
-- Tunables (INV-4). Vision costs money per call, so the cap is a setting.
-- ---------------------------------------------------------------------------
insert into setting (org_id, workflow_id, key, value_json, description)
select o.org_id, w.workflow_id, s.key, s.val::jsonb, s.descr
from organization o
join workflow w on w.org_id = o.org_id and w.code = 'qc_support'
cross join (values
  ('vision.enabled', 'true',
   'Describe diagrams, photos, charts and tables with a vision model during ingestion. Set false to skip the vision step entirely (text-only ingestion).'),
  ('vision.max_visuals_per_document', '40',
   'Cost guard. At most this many pages or images per document are sent to the vision model; the rest are skipped and logged.'),
  ('vision.page_render_scale', '2',
   'PDF page screenshots are rendered at this zoom before being sent to the vision model. Higher reads small labels better and costs more.'),
  ('vision.min_image_px', '100',
   'An embedded image whose smaller side is under this many pixels (icons, bullets, logos) does not, by itself, send a page to the vision model.'),
  ('vision.min_vector_ops', '150',
   'A PDF page with at least this many vector-drawing operations is treated as containing a diagram (a diagram drawn as vectors has no embedded image to detect).')
) as s(key, val, descr)
where o.name = 'DRIG USA'
  on conflict (org_id, workflow_id, key) do nothing;
