-- ============================================================================
-- 0830  Printed page labels                              PORTABLE: Supabase + RDS
-- ============================================================================
-- page_number is the PDF's own page index (1 = first page in the file). A
-- manual's printed page number is often different: the AD Plus2.0 manual's
-- PDF page 16 is printed "Page 8 of 104", after eight pages of cover and
-- contents. A technician holding the printed manual looks for 8.
--
-- page_label is the number printed on the page, read from its header or footer
-- at ingestion (pdfStructure.js). Null when the page shows none: citations then
-- fall back to page_number. Everything internal (chunks, images, retrieval)
-- keeps using page_number; the label is only what people are shown.
-- ============================================================================

alter table kb_document_page add column if not exists page_label text;
