-- ============================================================================
-- 0750  kb_image: one description per picture per version    PORTABLE
-- ============================================================================
-- ADDITIVE, follows 0740. Vision descriptions are now saved the moment the model
-- returns them (not at the end of the document), so a job that crashes or is
-- retried keeps everything it already paid for. Writing them one at a time, from
-- concurrent calls, and again at the end needs a uniqueness rule to be idempotent:
-- the same picture in the same version is stored once (ON CONFLICT DO NOTHING).
--
-- Rows written before this migration could already contain a duplicate (two pages
-- that render identically share a hash), which would make the index fail to build,
-- so the extras are removed first. They are copies of the same description.
-- ============================================================================

delete from kb_image a
 using kb_image b
 where a.content_hash is not null
   and a.doc_id = b.doc_id
   and a.version = b.version
   and a.content_hash = b.content_hash
   and a.image_id > b.image_id;

create unique index if not exists kb_image_doc_version_hash
  on kb_image (doc_id, version, content_hash)
  where content_hash is not null;
