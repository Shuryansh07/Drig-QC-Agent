# DRIG Standard documents: manuals and the vehicle wiring guide

DRIG's own documentation always comes before anything else the assistant holds.

| Question type | Looked up in, in order |
|---|---|
| Installation / product question | 1. DRIG Standard manuals → 2. every other manual |
| Vehicle 12V / ignition wiring | 1. DRIG vehicle wiring guide → 2. Wiresheet (scraped), **per circuit**, only where DRIG has nothing usable → 3. "call QC" |

## Manuals

- `kb_document.collection` is `'drig'` for a DRIG Standard manual, `'general'` otherwise (migration 0840).
- Admin → Knowledge base → **DRIG Standard manuals** uploads with `collection=drig`. Uploading a file that is already an ordinary manual promotes it. "Make DRIG Standard" / "Move to other manuals" on any row changes it without re-processing.
- Retrieval (`ragRetrieval.service.js`) searches the live DRIG manuals first, narrowed by the equipment filter when the question names a product. If that passes the normal admission gate, only DRIG evidence is used. Otherwise it searches every manual exactly as before. The log line says which: `answered from DRIG Standard manuals` or `no DRIG Standard manual answers it`.

## Vehicle wiring guide

**Import** (Admin → Knowledge base → **DRIG wiring guide**, `.xlsx`):

1. The workbook is stored in the `drig-qc-wiresheet` bucket (`imports/<sha256>/<name>`). A worker job `import_drig_wiring` is then queued.
2. **Parse.** Columns are found by header: Year, Make, Model, Install Guide 12v, Install Guide Ignition, Requires Login, Need to download then upload. Each row becomes one `drig_wiring_vehicle` row plus two `drig_wiring_entry` rows (12V, ignition), kept verbatim.
   - The model's start type is parsed out: "ILX PTS" → model "ILX", type `pts`. A model with no PTS/Key suffix applies to both start types.
   - Rows with a year but no make or model (the sheet's dragged-down placeholders) are skipped and counted.
3. **Links.** Each distinct link is fetched once and cached in `drig_wiring_link` across imports. Files are stored by content hash in `drig_wiring_asset`:
   - `img/<sha>.<ext>` is the original photo, `doc/<sha>.pdf` a guide.
   - `preview/<sha>.jpg` is about 1600 px (a PDF's page 1); `thumb/<sha>.jpg` is about 320 px.
   - Fetched: Google Cloud Storage and Directechs blob photos, Google Drive files, Google Docs and Slides (exported as PDF), and Wiresheet `IMGwires` photos DRIG pasted in.
   - Skipped with a reason: Directechs pages (`requires_login`), pasted Wiresheet icons (`icon`), Drive folders and anything else (`unsupported`).
   - Failed links are retried on the next import.
4. **Publish.** The import becomes the live guide in one transaction. The previous guide stays live until then.
5. **OCR.** Each new photo (and any PDF without a text layer) is read once by `OPENAI_WIRING_OCR_MODEL` (default `gpt-5`). The result is a verbatim transcription with arrow and highlight notes and a confidence level. The model is told never to infer or pick a wire.
   - This happens at import, never in the chat path. It takes about 10–20 s per photo, three at a time.
   - The April 2026 guide has about 235 files to fetch and read.

**Chat:**

- A question about a vehicle's 12V or ignition wire is detected by `wiringIntent.service.js`. A keyword pre-check runs first, then a small model call.
- The lookup needs the year, make, model **and** start type (Todd Q7). If any is missing, the chat shows a vehicle form. The form's lists come from both sources: `GET /api/wiring/vehicle-options`.
- The lookup is exact: never a nearby year. Makes and models are compared without case or punctuation. "Dodge/Ram" answers to Dodge and Ram, "Mercedes" to "Mercedes Benz".
- The answer is composed from the stored values. No model writes it.
  - DRIG text is shown as written.
  - A DRIG photo is shown with its OCR text and "confirm on the photo".
  - A Wiresheet value is labelled "written for remote-start installs, can differ from DRIG's standard".
  - Nothing in either source means a QC handoff, and the question is logged as a gap.
  - Wiring answers are never copied into the FAQ.

## Configuration

| Variable | Default | |
|---|---|---|
| `S3_DRIG_WIRING_BUCKET` | `drig-qc-wiresheet` | The API needs `s3:PutObject` (workbook upload) and `s3:GetObject` (signed links). The worker needs Put and Get. |
| `S3_WIRESHEET_BUCKET` | `qc-wiresheet` | The API needs `s3:GetObject` to sign Wiresheet photos in answers. |
| `OPENAI_WIRING_OCR_MODEL` | `gpt-5` | Also `OPENAI_WIRING_OCR_REASONING` (default `low`) and `DRIG_WIRING_OCR_CONCURRENCY` (default 3). |
| `OPENAI_WIRING_INTENT_MODEL` | `OPENAI_EQUIPMENT_MODEL` or `gpt-4o-mini` | `WIRING_ROUTE_ENABLED=false` turns the wiring path off. |
| `DRIG_WIRING_LINK_CONCURRENCY` | 4 | Also `DRIG_WIRING_FETCH_TIMEOUT_MS` (30000) and `DRIG_WIRING_FETCH_MAX_BYTES` (30 MB). |
| `ADMIN_API_TOKEN` | unset | When set, uploads, deletes, retries, collection changes, Drive sync and wiring imports need `Authorization: Bearer <token>`. When unset, they stay open as before, with a startup warning. |

## Security notes

- **Links in the workbook are untrusted input to a server-side fetch.** Only the allowlisted hosts are requested, over HTTPS, and every redirect hop is re-checked. Responses are capped by size and time, and the bytes must really be an image or PDF. No link can reach an internal address.
- **The buckets stay private.** The database stores object keys only, and the chat gets one-hour signed URLs.
- **Uploads are checked by extension and by contents** (PDF/DOCX magic, xlsx zip header), with size limits. A wrong workbook is rejected with a clear message.
- **The admin token guard** is a stop-gap until sign-in exists. Replace it with `app_role` / `permission` checks then.
