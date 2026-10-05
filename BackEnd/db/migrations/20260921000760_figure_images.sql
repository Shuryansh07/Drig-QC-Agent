-- ============================================================================
-- 0760  Figure images: render sharper                 PORTABLE: Supabase + RDS
-- ============================================================================
-- ADDITIVE, follows 0740/0750. Described pictures are now stored in S3
-- (kb_image.s3_key, nullable since 0740) and attached to the answer when a
-- question lands on them, so the model reads the drawing itself.
--
-- Wiring labels printed in small type were unreadable at render scale 2. Raise
-- the seeded default to 3, but only where it is still the old default, so an
-- admin's own value is never overwritten. Safe to rerun.
-- ============================================================================

update setting
   set value_json = '3'::jsonb
 where key = 'vision.page_render_scale'
   and value_json = '2'::jsonb;
