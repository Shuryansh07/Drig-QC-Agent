-- RAG ingestion schema: documents, document_images, document_chunks.
-- Additive only. Does NOT touch "TestTable" or any existing data.

-- 1. pgvector (currently NOT installed on this project)
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- 2. Document processing status
DO $$ BEGIN
  CREATE TYPE document_status AS ENUM ('processing', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 3. documents
CREATE TABLE IF NOT EXISTS public.documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   text NOT NULL DEFAULT 'default',
  file_name     text NOT NULL,
  status        document_status NOT NULL DEFAULT 'processing',
  page_count    integer,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documents_customer_id_idx ON public.documents (customer_id);

-- 4. document_images (page snapshots live in Storage; this row is metadata only)
CREATE TABLE IF NOT EXISTS public.document_images (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  page_number  integer NOT NULL,
  image_index  integer NOT NULL DEFAULT 0,
  storage_path text NOT NULL,
  width        integer,
  height       integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, page_number, image_index)
);

CREATE INDEX IF NOT EXISTS document_images_document_page_idx ON public.document_images (document_id, page_number);
CREATE INDEX IF NOT EXISTS document_images_page_number_idx ON public.document_images (page_number);

-- 5. document_chunks (the actual RAG content + embedding)
CREATE TABLE IF NOT EXISTS public.document_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  customer_id  text NOT NULL,
  page_number  integer NOT NULL,
  chunk_index  integer NOT NULL,
  content      text NOT NULL,
  metadata     jsonb,
  embedding    vector(1536),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, page_number, chunk_index)
);

CREATE INDEX IF NOT EXISTS document_chunks_document_page_idx ON public.document_chunks (document_id, page_number);
CREATE INDEX IF NOT EXISTS document_chunks_customer_id_idx ON public.document_chunks (customer_id);

-- HNSW vector index for cosine similarity search (pgvector 0.8.2 supports hnsw natively)
CREATE INDEX IF NOT EXISTS document_chunks_embedding_hnsw_idx
  ON public.document_chunks USING hnsw (embedding vector_cosine_ops);

-- 6. RLS: enabled with NO policies on all three tables.
--    The backend talks to Postgres via DATABASE_URL (table owner), which bypasses RLS,
--    so the app keeps working. Anon/authenticated Supabase clients get zero access
--    to these tables (no policies = default deny), same posture the advisor wants.
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;

-- 7. Private Storage bucket for page snapshots (PNG only, 5MB/file cap).
--    public = false: only the service-role backend (supabaseAdmin) can read/write it.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('document-pages', 'document-pages', false, 5242880, ARRAY['image/png'])
ON CONFLICT (id) DO NOTHING;
