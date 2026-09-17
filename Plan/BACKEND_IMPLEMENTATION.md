# Backend — Implementation Reference

This replaces `BACKEND_MEMORY.md`. That file documented a planned, much larger
system (session frames, SSE streaming, multi-gate answer validation) that was
never built. This document describes what actually exists in `BackEnd/` today
— a working multimodal RAG ingestion + query pipeline with a background job
queue, verified against the real database and real external APIs, not a plan.

---

## 1. Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22, Express 5 (`"type": "module"`, plain ESM) |
| ORM | Prisma 7 (`@prisma/adapter-pg` driver adapter) |
| Database | PostgreSQL (Supabase-hosted) + **pgvector** extension |
| Vision LLM + final answer generation | OpenAI `gpt-4o-mini` (`OPENAI_VISION_MODEL`) |
| Embeddings | OpenAI `text-embedding-3-small`, 1536-dim (`OPENAI_EMBEDDING_MODEL`) |
| PDF parsing/rendering | `pdf-parse` (wraps `pdfjs-dist` + `@napi-rs/canvas`, no external binary) |
| File upload | `multer` (disk storage — never `memoryStorage`) |
| Permanent archive | Zoho WorkDrive API (OAuth2 refresh-token flow) |
| Background jobs | Hand-rolled PostgreSQL queue (`FOR UPDATE SKIP LOCKED`) — **no Redis, no BullMQ** |
| Logging | Custom logger (`utils/logger.js`) — console + `logs/app.log` |

Two separate long-running processes, same codebase:
```
npm run dev          # API — src/server.js
npm run dev:worker    # background worker — src/worker.js  (both required)
```

---

## 2. Database schema

5 tables. `TestTable` predates this work and is unrelated — never touched.

```
documents (1)
  │
  ├──< document_pages   (document_id, page_number) — per-page resumable state
  ├──< document_chunks  (document_id, page_number, chunk_index) — the RAG content + pgvector embedding
  └──< jobs             (document_id) — the background job queue
```

### `documents`
`id, customer_id, file_name, sha256, workdrive_file_id, workdrive_folder_id, status, page_count, processed_pages, failed_pages, temp_file_path, error_message, created_at, updated_at`

`status` (`DocumentStatus` enum): `queued → processing → rag_processing → workdrive_uploading → completed` (happy path), or `rag_completed` (RAG done, WorkDrive still pending/failed), `completed_with_errors` (some pages permanently failed), `failed` (fatal — invalid PDF, zero pages, or every page failed).

`temp_file_path` is kept (not cleared) as long as any retryable work remains — only cleared once the document reaches `completed` or `failed`, since a retry needs the original bytes to re-derive page text/images.

### `document_pages`
`id, document_id, page_number, status, retry_count, last_error, has_visual, vision_processed, vision_content, embedding_completed, started_at, completed_at`. Unique on `(document_id, page_number)`.

`vision_content` is the actual persisted Vision LLM output — this is what makes retry idempotent: if it's already populated, a retry skips the Vision call entirely and goes straight to embedding.

`status` values: `pending → processing → vision_processing → vision_completed → embedding → completed`, or `failed`.

### `document_chunks`
`id, document_id, customer_id, page_number, chunk_index, content, metadata (jsonb), embedding (vector(1536)), created_at`. Unique on `(document_id, page_number, chunk_index)`, upserted via `ON CONFLICT ... DO UPDATE` for idempotency. `customer_id` is denormalized from `documents` so the query-time similarity search never needs a join to enforce tenant isolation. HNSW index on `embedding` (cosine ops).

`content` is **Vision-LLM-processed text**, not raw PDF text, for any page that had a visual. Plain-text pages store the extracted PDF text directly (Vision is skipped for them).

### `jobs`
`id, job_type, document_id, page_number (reserved, unused), payload (jsonb, unused), status, attempts, max_attempts, run_at, locked_at, locked_by, last_error, created_at, updated_at`. One job type in active use: `process_document` — **document-granular, not page-granular** (page-level state already lives in `document_pages`; duplicating it in the job table was deliberately avoided).

Indexes: `(status, run_at)`, `(document_id, status)`, and a partial index on `run_at WHERE status = 'pending'` for the claim query's hot path.

There is **no `document_images` table** — page snapshots are never persisted anywhere. A visual page's screenshot exists only in memory during ingestion, feeds one Vision call, and is discarded.

---

## 3. Ingestion flow

```
POST /api/documents/upload
   │
   ▼
multer saves PDF to disk (TEMP_UPLOAD_DIR, absolute path)
   │
   ▼
enqueueIngestion() — ragIngestion.service.js
   ├── SHA-256 the file
   ├── dedup check (same customer + same hash + already completed → reuse, no reprocessing)
   ├── create `documents` row (status: queued)
   └── create `jobs` row (process_document)
   │
   ▼
202 Accepted, ~0.5-0.9s, regardless of document size
```

```
src/worker.js — polls every JOB_POLL_INTERVAL_MS, claims up to JOB_CONCURRENCY jobs at once
   │
   ▼
claimNextJob() — atomic `FOR UPDATE SKIP LOCKED` claim (jobQueue.service.js)
   │
   ▼
processDocument() — ragIngestion.service.js (the ONLY place real work happens)
   ├── status: rag_processing
   ├── parsePdfPages() — per-page text + (only for pages with an embedded image) a rendered screenshot
   ├── upsert document_pages (idempotent — retry-safe)
   ├── skip pages already status='completed'
   ├── for each remaining page, PAGE_CONCURRENCY at a time:
   │     visual page  → analyzePage() [Vision LLM] → persist vision_content → chunk → embed → pgvector
   │     text-only page → chunk directly → embed → pgvector
   │     (both Vision and embedding calls go through a GLOBAL concurrency limiter + retryWithBackoff —
   │      see §5)
   ├── status: workdrive_uploading
   ├── uploadOriginalPdf() → verify → save workdrive_file_id (only if not already archived)
   ├── final status: completed / completed_with_errors / rag_completed / failed
   └── delete temp file ONLY if nothing could still need it (completed or fatal failed)
   │
   ▼
completeJob() / failJob() (backoff-scheduled retry if attempts remain, else permanently failed)
```

`GET /api/documents/:id/status` — polls progress: document status, page counts, per-status page breakdown, latest job state.

`POST /api/documents/:id/retry` — validates the document is in a retryable state and the temp file still exists, enqueues another `process_document` job. Same function (`processDocument`) runs — it just skips everything already done.

---

## 4. Query flow

```
POST /api/rag/query  { customer_id, question }
   │
   ▼
generateEmbedding(question)          — 1 OpenAI embeddings call
   │
   ▼
retrieveRelevantChunks()             — pgvector cosine search, WHERE customer_id = $1, top RAG_MATCH_COUNT
   │  (ragRetrieval.service.js)
   ▼
generateAnswer()                     — 1 OpenAI chat completion, grounded + cited prompt, text-only
   │  (answerGeneration.service.js)
   ▼
{ answer, sources: [{document_id, page_number}] }
```

**Exactly 3 external calls, no branching, every time**: embed question → pgvector search → generate answer. No WorkDrive call, no image download, no Vision call — deliberately removed from this path to keep it fast (measured ~3.5s total round-trip; before images were removed from the answer-generation step it was ~8.5s).

The final-answer system prompt explicitly requires plain prose (no markdown — the frontend renders plain text, so markdown symbols would show as literal characters) and page citations woven into sentences, not just correctness rules.

---

## 5. Reliability mechanisms (all verified with real reproductions, not just written)

- **Idempotency**: `document_pages` upsert (create-if-missing, never overwrites existing state) + `document_chunks` `ON CONFLICT DO UPDATE`. A retry can never create duplicate chunks or redo a page that already has `vision_content` persisted.
- **Global concurrency limiting** (`utils/concurrencyLimiter.js`): `VISION_CONCURRENCY` and `EMBEDDING_CONCURRENCY` are real shared semaphores across the whole worker process — not per-document. Prevents N documents processing concurrently from multiplying OpenAI load.
- **Retry with backoff** (`utils/retry.js`, `retryWithBackoff`): wraps Vision and embedding calls (`VISION_MAX_RETRIES`/`EMBEDDING_MAX_RETRIES`, 2s→4s→8s→16s→32s schedule) on top of a small SDK-level `maxRetries` (`OPENAI_MAX_RETRIES=2`, kept low to avoid the two layers compounding). Added after a real incident: a 75-page document hit a sustained OpenAI 429 (200k TPM budget saturated for an extended stretch) and 43 pages failed because the SDK's own short retry window wasn't patient enough. Also used by `workdrive.service.js`.
- **Stale job recovery**: any job still `running` after `STALE_JOB_TIMEOUT_MS` (15 min default) is assumed to belong to a crashed worker and requeued (or marked `failed` if `max_attempts` is exhausted). Runs on worker startup and every 5 minutes.
- **Temp file lifecycle**: `TEMP_UPLOAD_DIR` **must** resolve to an absolute path (it does, via `path.resolve()`) — this was a real bug: a relative value caused the orphan-cleanup sweep to compare against the database's absolute paths, never match, and delete files that were still legitimately needed by a retryable document. Fixed and reproduced-tested.
- **Page-level failure visibility**: every page failure logs `[ERROR] page N failed` with the full provider error, not just a silent DB write — this was also a real gap found while diagnosing the 429 incident above.

---

## 6. API endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/documents/upload` | Save PDF, enqueue ingestion, return `202` immediately |
| `POST` | `/api/documents/:id/retry` | Enqueue a retry job (only redoes incomplete work) |
| `GET` | `/api/documents/:id/status` | Poll progress |
| `POST` | `/api/rag/query` | `{customer_id, question}` → `{answer, sources}` |
| `GET` | `/api/health` | Queue stats: pending/running/completed/failed/stale job counts |
| `POST` | `/api/pdf/upload` | Legacy — raw text extraction only, no RAG. Predates this pipeline, kept for compatibility. |

---

## 7. External API surface (complete list)

| Service | Endpoint | Used by | Frequency |
|---|---|---|---|
| OpenAI | `chat.completions.create` | `vision.service.js` | Once per visual page (ingestion) |
| OpenAI | `chat.completions.create` | `answerGeneration.service.js` | Once per query |
| OpenAI | `embeddings.create` | `embedding.service.js` | Once per page (ingestion) + once per query |
| Zoho WorkDrive | `POST oauth/v2/token` | `workdrive.service.js` | ~Hourly (token refresh) |
| Zoho WorkDrive | `POST /upload` | `workdrive.service.js` | Once per document, after all pages complete |
| Zoho WorkDrive | `GET /files/{id}` | `workdrive.service.js` | Once per upload, to verify |

No Supabase Storage (removed — no image persistence anywhere). No Supabase Auth. No other third-party service.

---

## 8. Environment variables

```env
PORT=5000
DATABASE_URL=...          # Supabase pooler
DIRECT_URL=...            # Supabase pooler (migrations)

# OpenAI
OPENAI_API_KEY=
OPENAI_VISION_MODEL=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
OPENAI_MAX_RETRIES=2              # SDK-level, kept small deliberately

# Ingestion concurrency
PAGE_CONCURRENCY=3                # pages of ONE document started at once
VISION_CONCURRENCY=2              # GLOBAL cap across all documents/jobs
EMBEDDING_CONCURRENCY=2           # GLOBAL cap
EMBEDDING_BATCH_SIZE=20

# Our own retry (outer, longer than the SDK's)
VISION_MAX_RETRIES=5
EMBEDDING_MAX_RETRIES=5
MAX_RETRIES=3                     # generic default (WorkDrive uses WORKDRIVE_MAX_RETRIES instead)

# Timeouts (ms)
VISION_TIMEOUT_MS=90000
EMBEDDING_TIMEOUT_MS=30000
WORKDRIVE_TIMEOUT_MS=60000

# Job queue
JOB_CONCURRENCY=2                 # documents ONE worker processes at once
JOB_POLL_INTERVAL_MS=1000
MAX_JOB_ATTEMPTS=3
STALE_JOB_TIMEOUT_MS=900000

# Temp files
TEMP_UPLOAD_DIR=.tmp/uploads      # resolved to absolute at load time — do not rely on it staying relative

# Zoho WorkDrive
ZOHO_ACCOUNTS_DOMAIN=https://accounts.zoho.com
ZOHO_WORKDRIVE_API=https://www.zohoapis.com/workdrive/api/v1
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=
WORKDRIVE_FOLDER_ID=              # verify against the live API — a browser URL's folder ID is not always the real parent_id
WORKDRIVE_MAX_RETRIES=3

# RAG query
RAG_MATCH_COUNT=6
```

---

## 9. Known limitations (stated plainly, not hidden)

- No automated test suite (no jest/vitest installed) — everything has been verified via real, live requests against the real database and real OpenAI/WorkDrive APIs, documented inline as they were run, not via mocked unit tests.
- Never tested at genuinely large scale (500+ pages) end-to-end, though the architecture (async job + resumable pages) is specifically designed to not require it to complete in one HTTP request.
- Only ever run with a single worker process — multiple workers claiming from the same queue should work correctly (`FOR UPDATE SKIP LOCKED` guarantees it), but hasn't been directly observed side-by-side.
- `customer_id` is a free-text field, not a foreign key to a real customers/auth table (none exists in this project yet) — tenant isolation is enforced at the query level, but nothing stops a client from claiming any `customer_id` string.
- No `api_usage` telemetry table (call counts, token usage, per-provider stats) — scoped out as lower priority; timing/outcome is only in the log stream, not queryable historical data.
